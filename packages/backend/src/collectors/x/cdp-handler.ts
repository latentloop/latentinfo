/**
 * X/Twitter collector — CDP page handler.
 *
 * Ported from x_x/scrape.js. Installs page-side module for tweet extraction,
 * registers MutationObserver/scroll watchers, and stores tweets as XDocuments.
 *
 * Flow:
 *   pageHandler installs module -> initial scrape -> registers onNotify
 *   Page MutationObserver/scroll detects tweets -> calls __latentNotify
 *   Backend receives notification -> runs scrapeTweets()
 */

import type { Client } from "@libsql/client"
import type { PageProxy } from "../../collector-runner.js"
import type { XDocument } from "./types.js"
import { emitJobEvent } from "../../job-runner.js"
import { broadcastSseEvent } from "../../server.js"
import { createLogger } from "../../logger.js"
import { fetchCachedImages } from "./media-cache.js"
import {
  cssEscape,
  extractTweets,
  addBadges,
  getViewportState,
  waitForScrollIdle,
  getClipPlan,
  cropScreenshot,
  startWatching,
} from "./page-functions.js"
const log = createLogger("x")

const MODULE_NAME = "li_x"
const NOTIFY_KEY = "li_x:new_tweets"
const WATCHING_FLAG = "__latent_info_x_watching"

// ---------------------------------------------------------------------------
// Types for data returned from page-side functions
// ---------------------------------------------------------------------------

interface RawTweet {
  url: string
  text: string
  timestamp: string | null
  imageUrls: string[]
  contentLinks: { url: string; text: string }[]
  quotedTweetUrl: string | null
  cardLink: string | null
  parentTweetUrl: string | null
  avatarUrl: string
  displayName: string
  handle: string
  screenshot?: string | null
}

interface Trigger {
  key: string
  reason: string
  detectedAt: number | null
  visibleCount: number | null
}

interface ClipRect {
  x: number
  y: number
  width: number
  height: number
}

interface ScrollState {
  x: number
  y: number
}

// ---------------------------------------------------------------------------
// Backend-side helpers
// ---------------------------------------------------------------------------

const SHOT_EDGE_MARGIN = 24
const SHOT_MIN_VISIBLE_RATIO = 0.92
const SHOT_SCROLL_IDLE_MS = 220
const SHOT_SCROLL_TIMEOUT_MS = 2200
const SHOT_RETRY_MAX = 2
const SHOT_SCROLL_TOLERANCE_PX = 1
const SHOT_LAYOUT_TOLERANCE_PX = 3

function shouldCaptureScreenshots(reason: string): boolean {
  return reason === "initial" || reason === "mutation" || reason === "scroll_idle" || reason === "legacy"
}

function didScrollMove(before: ScrollState | null, after: ScrollState | null, tolerancePx: number): boolean {
  if (!before || !after) return false
  return Math.abs(after.x - before.x) > tolerancePx || Math.abs(after.y - before.y) > tolerancePx
}

function didRectsShift(
  beforeRects: (ClipRect | null)[],
  afterRects: (ClipRect | null)[],
  tolerancePx: number,
): boolean {
  if (!Array.isArray(beforeRects) || !Array.isArray(afterRects)) return false
  if (afterRects.length < beforeRects.length) return true
  for (let i = 0; i < beforeRects.length; i++) {
    const a = beforeRects[i]
    if (!a) continue
    const b = afterRects[i]
    if (!b) return true
    if (
      Math.abs((b.x || 0) - (a.x || 0)) > tolerancePx ||
      Math.abs((b.y || 0) - (a.y || 0)) > tolerancePx ||
      Math.abs((b.width || 0) - (a.width || 0)) > tolerancePx ||
      Math.abs((b.height || 0) - (a.height || 0)) > tolerancePx
    ) return true
  }
  return false
}

function makeTrigger(reason: string): Trigger {
  return { key: NOTIFY_KEY, reason, detectedAt: Date.now(), visibleCount: null }
}

// ---------------------------------------------------------------------------
// pageHandler — called by collector-runner when an X page is detected
// ---------------------------------------------------------------------------

export function createPageHandler(page: PageProxy, db: Client): void {
  const t0 = Date.now()
  const ts = () => `+${Date.now() - t0}ms`

  // State
  const urlStateCache = new Map<string, { hasScreenshot: boolean; ymd: string; collectedAt: string }>()
  const pendingScreenshotUrls = new Set<string>()
  let scraping = false
  let queuedTrigger: Trigger | null = null
  let screenshotRunning = false
  let screenshotQueued = false
  let screenshotTrigger: Trigger | null = null
  let screenshotTimer: ReturnType<typeof setTimeout> | null = null
  let screenshotDueAt = 0

  function rememberUrlState(url: string, state: { hasScreenshot: boolean; ymd: string; collectedAt: string }) {
    urlStateCache.set(url, state)
    if (state.hasScreenshot) pendingScreenshotUrls.delete(url)
    else pendingScreenshotUrls.add(url)
  }

  // ── DB helpers ──────────────────────────────────────────────────

  async function readExistingIds(ids: string[]): Promise<Map<string, { hasScreenshot: boolean; ymd: string; collectedAt: string }>> {
    if (!ids || ids.length === 0) return new Map()
    const result = new Map<string, { hasScreenshot: boolean; ymd: string; collectedAt: string }>()
    try {
      const placeholders = ids.map(() => "?").join(",")
      const rows = await db.execute({
        sql: `SELECT id, doc FROM documents WHERE id IN (${placeholders})`,
        args: ids,
      })
      for (const r of rows.rows) {
        const id = r.id as string
        const doc = typeof r.doc === "string" ? JSON.parse(r.doc) as Record<string, unknown> : (r.doc as unknown as Record<string, unknown>)
        const collectedAt = typeof doc.collectedAt === "string" ? (doc.collectedAt as string) : ""
        result.set(id, {
          hasScreenshot: !!doc.screenshot,
          ymd: collectedAt ? collectedAt.slice(0, 10) : "",
          collectedAt,
        })
      }
    } catch (e: unknown) {
      log.debug(`DB dedup read error (non-fatal): ${e instanceof Error ? e.message : e}`)
    }
    return result
  }

  async function upsertDocument(docId: string, doc: XDocument): Promise<boolean> {
    try {
      await db.execute({
        sql: "INSERT INTO documents (id, doc) VALUES (?, json(?)) ON CONFLICT(id) DO UPDATE SET doc = excluded.doc",
        args: [docId, JSON.stringify(doc)],
      })
      return true
    } catch (e: unknown) {
      log.error(`DB write error: ${e instanceof Error ? e.message : e}`)
      return false
    }
  }

  // ── Scrape logic ──────────────────────────────────────────────

  async function scrapeTweets(opts: {
    screenshot?: boolean
    includeBadgedNeedsScreenshot?: boolean
    onlyNeedsScreenshot?: boolean
    trigger?: Trigger | null
    phase?: string
  }): Promise<{ saved: number; newRows: number; screenshotAttached: number }> {
    const { screenshot = false, includeBadgedNeedsScreenshot = false, onlyNeedsScreenshot = false, trigger = null, phase = "meta" } = opts
    const scrapeStartedAt = Date.now()
    const triggerPart = trigger
      ? ` trigger=${trigger.reason || "unknown"} lag=${trigger.detectedAt ? (scrapeStartedAt - trigger.detectedAt) + "ms" : "na"}`
      : ""
    const scrapedYmd = new Date().toISOString().slice(0, 10)

    // Extract tweets from page
    const extractStart = Date.now()
    const extracted = await page.callModule(MODULE_NAME, "extractTweets", {
      includeBadgedNeedsScreenshot,
      onlyNeedsScreenshot,
    }) as RawTweet[] | null
    const extractMs = Date.now() - extractStart

    const tweets: RawTweet[] = []
    const seenUrls = new Set<string>()
    for (const t of (extracted || [])) {
      if (!t || !t.url || seenUrls.has(t.url)) continue
      seenUrls.add(t.url)
      tweets.push(t)
    }

    if (tweets.length === 0) {
      log.debug(`[${ts()}] scrape ${phase} skip (no tweets) extract=${extractMs}ms${triggerPart}`)
      return { saved: 0, newRows: 0, screenshotAttached: 0 }
    }

    // Dedup: check which tweet IDs already exist in DB
    const dbReadStart = Date.now()
    const existingMap = new Map<string, { hasScreenshot: boolean; ymd: string; collectedAt: string }>()
    const missingDocIds: string[] = []

    for (const t of tweets) {
      const statusMatch = t.url.match(/\/status\/(\d+)/)
      const tweetId = statusMatch ? statusMatch[1] : ""
      const docId = `x:${tweetId}`
      const cached = urlStateCache.get(t.url)
      if (cached) {
        existingMap.set(t.url, cached)
      } else {
        missingDocIds.push(docId)
      }
    }

    if (missingDocIds.length > 0) {
      const dbResult = await readExistingIds(missingDocIds)
      for (const t of tweets) {
        const statusMatch = t.url.match(/\/status\/(\d+)/)
        const tweetId = statusMatch ? statusMatch[1] : ""
        const docId = `x:${tweetId}`
        const state = dbResult.get(docId)
        if (state) {
          existingMap.set(t.url, state)
          rememberUrlState(t.url, state)
        }
      }
    }
    const dbReadMs = Date.now() - dbReadStart

    // Split into new/existing
    const upsertRows: { tweet: RawTweet; wasExisting: boolean; ymd: string }[] = []
    const existingBadges: { pathname: string; ymd: string; isExisting: boolean; hasScreenshot: boolean; collectAt: string }[] = []

    for (const t of tweets) {
      const prev = existingMap.get(t.url)
      if (!prev) {
        upsertRows.push({ tweet: t, wasExisting: false, ymd: scrapedYmd })
        continue
      }
      if (prev.hasScreenshot) {
        pendingScreenshotUrls.delete(t.url)
        existingBadges.push({
          pathname: new URL(t.url).pathname,
          ymd: prev.ymd || scrapedYmd,
          isExisting: true,
          hasScreenshot: true,
          collectAt: prev.collectedAt,
        })
        continue
      }
      pendingScreenshotUrls.add(t.url)
      if (screenshot) {
        upsertRows.push({ tweet: t, wasExisting: true, ymd: prev.ymd || scrapedYmd })
      } else {
        existingBadges.push({
          pathname: new URL(t.url).pathname,
          ymd: prev.ymd || scrapedYmd,
          isExisting: true,
          hasScreenshot: false,
          collectAt: prev.collectedAt,
        })
      }
    }

    // Badge existing tweets
    if (existingBadges.length > 0) {
      await page.callModule(MODULE_NAME, "addBadges", existingBadges)
    }

    if (upsertRows.length === 0) {
      log.debug(`[${ts()}] scrape ${phase} skip (no upserts) visible=${tweets.length}${triggerPart}`)
      return { saved: 0, newRows: 0, screenshotAttached: 0 }
    }

    // Screenshot capture
    let screenshotAttached = 0
    if (screenshot) {
      const screenshotUrls = upsertRows.map((row) => row.tweet.url)

      for (let attempt = 1; attempt <= SHOT_RETRY_MAX; attempt++) {
        // Wait for scroll to settle
        const idleResult = await page.callModule(MODULE_NAME, "waitForScrollIdle", {
          idleMs: SHOT_SCROLL_IDLE_MS,
          timeoutMs: SHOT_SCROLL_TIMEOUT_MS,
        }) as { idle: boolean } | null
        if (!idleResult || !idleResult.idle) break

        // Get clip rects
        const plan = await page.callModule(MODULE_NAME, "getClipPlan", {
          urls: screenshotUrls,
          strict: true,
          edgeMargin: SHOT_EDGE_MARGIN,
          minVisibleRatio: SHOT_MIN_VISIBLE_RATIO,
        }) as { rects: (ClipRect | null)[]; scroll: ScrollState } | null
        const rects = plan && Array.isArray(plan.rects) ? plan.rects : []
        if (!rects.some((r) => r !== null)) break

        const beforeScroll = plan?.scroll ?? null

        // Capture full viewport
        let buf: Buffer
        try {
          buf = await page.screenshot({
            format: "jpeg",
            quality: 68,
            fromSurface: false,
            optimizeForSpeed: true,
            captureBeyondViewport: false,
          })
        } catch (e: unknown) {
          log.warn(`screenshot capture failed: ${e instanceof Error ? e.message : e}`)
          break
        }

        // Verify no scroll movement
        const afterViewport = await page.callModule(MODULE_NAME, "getViewportState") as ScrollState | null
        if (didScrollMove(beforeScroll, afterViewport, SHOT_SCROLL_TOLERANCE_PX)) continue

        // Verify no layout shift
        const verifyPlan = await page.callModule(MODULE_NAME, "getClipPlan", {
          urls: screenshotUrls,
          strict: true,
          edgeMargin: SHOT_EDGE_MARGIN,
          minVisibleRatio: SHOT_MIN_VISIBLE_RATIO,
        }) as { rects: (ClipRect | null)[] } | null
        const verifyRects = verifyPlan && Array.isArray(verifyPlan.rects) ? verifyPlan.rects : []
        if (didRectsShift(rects, verifyRects, SHOT_LAYOUT_TOLERANCE_PX)) continue

        // Crop in page
        try {
          const fullBase64 = `data:image/jpeg;base64,${buf.toString("base64")}`
          const cropped = await page.callModule(MODULE_NAME, "cropScreenshot", {
            fullBase64,
            clips: rects,
            outputFormat: "image/jpeg",
            outputQuality: 0.82,
          }) as (string | null)[] | null

          for (let i = 0; i < upsertRows.length; i++) {
            if (cropped && cropped[i]) {
              upsertRows[i].tweet.screenshot = cropped[i]
              screenshotAttached++
            }
          }
        } catch (e: unknown) {
          log.warn(`screenshot crop failed: ${e instanceof Error ? e.message : e}`)
        }
        break
      }
    }

    // Fetch cached images (avatars + tweet media) from browser
    // The browser already loaded these images — fetch() with cache:force-cache
    // should serve from HTTP cache without new network requests.
    try {
      const mediaUrls: string[] = []
      for (const row of upsertRows) {
        if (row.tweet.avatarUrl && row.tweet.avatarUrl.startsWith("http")) mediaUrls.push(row.tweet.avatarUrl)
        for (const img of row.tweet.imageUrls || []) {
          if (img && img.startsWith("http")) mediaUrls.push(img)
        }
      }
      if (mediaUrls.length > 0) {
        const cached = await fetchCachedImages(page, mediaUrls)
        if (cached.size > 0) {
          for (const row of upsertRows) {
            const avatarData = cached.get(row.tweet.avatarUrl)
            if (avatarData) row.tweet.avatarUrl = avatarData
            row.tweet.imageUrls = (row.tweet.imageUrls || []).map((url) => cached.get(url) || url)
          }
        }
      }
    } catch (e: unknown) {
      log.debug(`Image cache fetch skipped: ${e instanceof Error ? e.message : e}`)
    }

    // Save documents
    let saved = 0
    let newRows = 0
    const savedBadgeItems: { pathname: string; ymd: string; isExisting: boolean; hasScreenshot: boolean; collectAt: string }[] = []
    const collectedAtIso = new Date().toISOString()

    for (const row of upsertRows) {
      if (row.wasExisting && !row.tweet.screenshot) continue

      const tweet = row.tweet
      const statusMatch = tweet.url.match(/\/status\/(\d+)/)
      const tweetId = statusMatch ? statusMatch[1] : ""
      const docId = `x:${tweetId}`
      const ymd = row.ymd || scrapedYmd

      // Skip promoted/ad tweets — they lack a timestamp
      if (!tweet.timestamp) continue

      let tweetHour = 0
      try { tweetHour = new Date(tweet.timestamp).getHours() } catch { /* ignore */ }

      // Preserve original collectedAt for existing tweets
      const originalCollectedAt = row.wasExisting
        ? (existingMap.get(tweet.url)?.collectedAt || collectedAtIso)
        : collectedAtIso

      const doc: XDocument = {
        type: "x",
        collectedBy: "x",
        url: tweet.url,
        collectedAt: originalCollectedAt,
        tweetId,
        text: tweet.text || "",
        tweetAt: tweet.timestamp || "",
        tweetHour,
        displayName: tweet.displayName || "",
        handle: tweet.handle || "",
        avatarUrl: tweet.avatarUrl || "",
        imageUrls: tweet.imageUrls || [],
        contentLinks: tweet.contentLinks || [],
        quotedTweetUrl: tweet.quotedTweetUrl || "",
        cardLink: tweet.cardLink || "",
        parentTweetUrl: tweet.parentTweetUrl || "",
        screenshot: tweet.screenshot || null,
      }

      const ok = await upsertDocument(docId, doc)
      if (ok) {
        saved++
        if (!row.wasExisting) newRows++
        rememberUrlState(tweet.url, { hasScreenshot: !!tweet.screenshot, ymd, collectedAt: originalCollectedAt })
        savedBadgeItems.push({
          pathname: new URL(tweet.url).pathname,
          ymd,
          isExisting: row.wasExisting,
          hasScreenshot: !!tweet.screenshot,
          collectAt: originalCollectedAt,
        })
      }
    }

    // Badge newly saved tweets
    if (savedBadgeItems.length > 0) {
      await page.callModule(MODULE_NAME, "addBadges", savedBadgeItems)
    }

    // Notify job system and SSE clients about new tweets
    if (newRows > 0) {
      emitJobEvent("x:collected", { saved, newRows })
      broadcastSseEvent("data-changed", { source: "x", count: saved })
    }

    const totalMs = Date.now() - scrapeStartedAt
    if (saved > 0) {
      log.info(
        `[${ts()}] scrape ${phase} saved=${saved} new=${newRows} visible=${tweets.length} shot=${screenshotAttached}` +
        ` total=${totalMs}ms extract=${extractMs}ms dbRead=${dbReadMs}ms${triggerPart}`,
      )
    } else {
      log.debug(
        `[${ts()}] scrape ${phase} done (no save) visible=${tweets.length} total=${totalMs}ms${triggerPart}`,
      )
    }

    return { saved, newRows, screenshotAttached }
  }

  // ── Screenshot pass scheduling ──────────────────────────────

  function armScreenshotPass(dueAt: number) {
    const delay = Math.max(0, dueAt - Date.now())
    if (screenshotTimer) clearTimeout(screenshotTimer)
    screenshotDueAt = dueAt
    screenshotTimer = setTimeout(() => {
      screenshotTimer = null
      screenshotDueAt = 0
      runScreenshotLoop().catch((e: unknown) => {
        log.error(`screenshot loop error: ${e instanceof Error ? e.message : e}`)
      })
    }, delay)
  }

  function requestScreenshotPass(trigger: Trigger | null, delayMs: number) {
    const nextTrigger = trigger || makeTrigger("backfill")
    const dueAt = Date.now() + Math.max(0, delayMs)
    screenshotTrigger = nextTrigger

    if (screenshotRunning) {
      screenshotQueued = true
      return
    }
    if (!screenshotTimer || dueAt < screenshotDueAt - 20) {
      armScreenshotPass(dueAt)
    }
  }

  async function runScreenshotLoop() {
    if (screenshotRunning) {
      screenshotQueued = true
      return
    }
    screenshotRunning = true

    try {
      do {
        screenshotQueued = false
        const trigger = screenshotTrigger || makeTrigger("backfill")
        screenshotTrigger = null

        await scrapeTweets({
          screenshot: true,
          includeBadgedNeedsScreenshot: true,
          onlyNeedsScreenshot: true,
          trigger,
          phase: "shot",
        })
      } while (screenshotQueued || screenshotTrigger)
    } finally {
      screenshotRunning = false
    }
  }

  // ── Scrape loop (metadata pass) ──────────────────────────────

  async function runScrapeLoop(initialTrigger: Trigger) {
    let trigger: Trigger | null = initialTrigger
    while (trigger) {
      await scrapeTweets({
        screenshot: false,
        includeBadgedNeedsScreenshot: false,
        trigger,
        phase: "meta",
      })

      if (shouldCaptureScreenshots(trigger.reason)) {
        const delay = trigger.reason === "mutation" ? 220 : 80
        requestScreenshotPass(trigger, delay)
      } else if (pendingScreenshotUrls.size > 0) {
        requestScreenshotPass(makeTrigger("backfill"), 220)
      }

      if (!queuedTrigger) return
      const queued = queuedTrigger
      queuedTrigger = null
      trigger = queued
      log.debug(`[${ts()}] draining queued notify reason=${trigger.reason}`)
    }
  }

  // ── Notify payload parsing ──────────────────────────────────

  function parseNotifyPayload(payload: string): Trigger | null {
    if (payload === NOTIFY_KEY) {
      return { key: NOTIFY_KEY, reason: "legacy", detectedAt: null, visibleCount: null }
    }
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>
      if (parsed && parsed.key === NOTIFY_KEY) {
        return {
          key: NOTIFY_KEY,
          reason: (parsed.reason as string) || "unknown",
          detectedAt: typeof parsed.detectedAt === "number" ? parsed.detectedAt : null,
          visibleCount: typeof parsed.visibleCount === "number" ? parsed.visibleCount : null,
        }
      }
    } catch {
      // ignore malformed
    }
    return null
  }

  // ── Main setup (async IIFE) ──────────────────────────────────

  void (async () => {
    try {
      // Install page-side module — functions are serialized via .toString()
      await page.installModule(MODULE_NAME, {
        cssEscape,
        extractTweets,
        addBadges,
        getViewportState,
        waitForScrollIdle,
        getClipPlan,
        cropScreenshot,
        startWatching,
      })

      // Start MutationObserver + scroll watcher on the page
      await page.callModule(MODULE_NAME, "startWatching", {
        appName: MODULE_NAME,
        notifyKey: NOTIFY_KEY,
        watchingFlag: WATCHING_FLAG,
        collectorId: "x",
      })

      // Register notification handler
      page.onNotify((payload: string) => {
        const trigger = parseNotifyPayload(payload)
        if (!trigger) return

        if (scraping) {
          queuedTrigger = trigger
          log.debug(`[${ts()}] notify queued reason=${trigger.reason}`)
          return
        }

        scraping = true
        log.debug(`[${ts()}] notify start reason=${trigger.reason}`)
        runScrapeLoop(trigger)
          .catch((e: unknown) => { log.error(`scrape error: ${e instanceof Error ? e.message : e}`) })
          .finally(() => { scraping = false })
      })

      // Initial scrape
      log.info(`[${ts()}] page setup complete, initial scrape on ${page.url.slice(0, 60)}`)
      const initialTrigger = makeTrigger("initial")
      await scrapeTweets({ screenshot: false, trigger: initialTrigger, phase: "meta" })
      requestScreenshotPass(initialTrigger, 80)
    } catch (e: unknown) {
      log.error(`X collector setup failed: ${e instanceof Error ? e.message : e}`)
    }
  })()
}
