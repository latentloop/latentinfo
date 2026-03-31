/**
 * Shared clip storage logic for the web_clipper collector.
 *
 * Used by both the action handler (manual clips) and auto-detect
 * (pattern-matched clips) to store HTML in SQLite and emit events.
 */

import { createHash } from "node:crypto"
import { emitJobEvent } from "../../job-runner.js"
import { broadcastSseEvent } from "../../server.js"
import { insertArticle, type ArticleRow } from "../../storage/article-db.js"
import { createLogger } from "../../logger.js"

const log = createLogger("web-clipper-store")

export interface StoreClipParams {
  html: string
  url?: string
  title?: string
  selector?: string
  imageUrls?: string[]
  /** When set, clip is from auto-detect (affects ID prefix and collectData). */
  patternId?: string
  /** Tweet author metadata (extracted page-side on X/Twitter). */
  handle?: string
  displayName?: string
  avatarUrl?: string
  /** Tweet datetime ISO string from <time> element (X/Twitter only). */
  tweetDate?: string
}

/**
 * Compute the deterministic sourceKey for a clip.
 *
 * Always keyed on the URL (+ optional selector). The URL is normalised for
 * x.com/twitter.com article URLs to `https://x.com/i/status/<tweetId>` so
 * that handle changes don't produce duplicate source keys for the same tweet.
 *
 * Used by storeClip (at write time) and by auto-detect (at dedup-check time)
 * to ensure both sides agree on the key.
 */
export function computeSourceKey(url: string, patternId: string, selector?: string): string {
  const normalised = normaliseUrl(url)
  const dedupInput = normalised + (selector ?? "")
  const dedupHash = createHash("sha256").update(dedupInput).digest("hex").slice(0, 16)
  return `${patternId}:${dedupHash}`
}

/** Normalise x.com / twitter.com article URLs to a stable, handle-independent form. */
function normaliseUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.hostname === "x.com" || u.hostname === "twitter.com" || u.hostname === "www.x.com" || u.hostname === "www.twitter.com") {
      const m = u.pathname.match(/\/status\/(\d+)/)
      if (m) return `https://x.com/i/status/${m[1]}`
    }
  } catch { /* not a valid URL — use as-is */ }
  return url
}

/**
 * Store a clip in SQLite and emit a web_clip:collected event.
 *
 * - Manual clips (no patternId): clipId = `url:<ts>:<hash>`, sourceKey = `url:<dedup-hash>`
 * - Auto-detect clips (patternId): clipId = `<pattern>:<ts>:<hash>`, sourceKey = `<pattern>:<dedup-hash>`
 *
 * sourceKey is always deterministic and URL-based (via computeSourceKey).
 */
export async function storeClip(params: StoreClipParams): Promise<{ clipId: string; sourceKey: string } | null> {
  const { html, url, title, selector, imageUrls, patternId, handle, displayName, avatarUrl, tweetDate } = params

  const timestamp = new Date().toISOString()
  const hash = createHash("sha256").update(html).digest("hex").slice(0, 12)

  // Pattern prefix: auto-detect uses the pattern name (e.g. "x_article"),
  // manual clips use "url" as the pattern.
  const prefix = patternId ?? "url"
  const clipId = `${prefix}:${Date.now()}:${hash}`

  const sourceKey = url
    ? computeSourceKey(url, prefix, selector)
    : `${prefix}:${createHash("sha256").update(html + (selector ?? "")).digest("hex").slice(0, 16)}`

  const collectData: Record<string, unknown> = {
    url: url ?? "",
    title: title ?? "",
    clipped_at: timestamp,
  }
  if (selector) collectData.selector = selector
  if (imageUrls && imageUrls.length > 0) collectData.imageUrls = imageUrls
  if (patternId) collectData.auto_detect_pattern = patternId
  if (handle) collectData.handle = handle
  if (displayName) collectData.displayName = displayName
  if (avatarUrl) collectData.avatarUrl = avatarUrl
  if (tweetDate) collectData.tweetDate = tweetDate

  const row: ArticleRow = {
    id: clipId,
    source_key: sourceKey,
    collect_data: JSON.stringify(collectData),
    content: html,
    markdown: "",
    media_data: [],
    created_at: timestamp,
  }

  try {
    await insertArticle(row)
    log.info({ clipId, url, title }, "Clip stored")
    emitJobEvent("web_clip:collected", { clipId })
    broadcastSseEvent("data-changed", { source: "web_clipper" })
    return { clipId, sourceKey }
  } catch (e: unknown) {
    log.error({ clipId, error: e instanceof Error ? e.message : e }, "Failed to store clip")
    return null
  }
}
