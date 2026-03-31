/**
 * In-memory X document cache with 5s TTL.
 *
 * - Loads all documents of type 'x' from the documents table
 * - Parses JSONB doc column to XDocument
 * - Builds sorted indices (byPostDate, byCollectedAt)
 * - Builds lookup maps (urlIndex, idIndex)
 * - Strips screenshot from list responses
 */

import type { Client } from "@libsql/client"
import type { XDocument, XItem } from "./types.js"
import { createLogger } from "../../logger.js"

const log = createLogger("x-cache")

interface CacheEntry {
  doc: XDocument
  id: string          // document id (e.g. "x:123456")
  collectedAt: string // from json_extract(doc, '$.collectedAt')
  hasScreenshot: boolean
}

interface XCache {
  entries: CacheEntry[]
  byPostDate: number[]      // indices sorted by tweetAt DESC
  byCollectedAt: number[]   // indices sorted by collectedAt DESC
  urlIndex: Record<string, number>  // url -> index
  idIndex: Record<string, number>   // document id -> index
}

let cache: XCache | null = null
let cacheError: Error | null = null
let lastCacheTime = 0
const CACHE_TTL_MS = 5000
let cleanupInProgress = false

function buildUrl(doc: XDocument): string {
  const handle = doc.handle ? doc.handle.replace(/^@/, "") : ""
  return `https://x.com/${handle}/status/${doc.tweetId}`
}

export function stripScreenshot(entry: CacheEntry): XItem {
  const doc = entry.doc
  return {
    rawData: {
      url: buildUrl(doc),
      tweetId: doc.tweetId,
      text: doc.text || "",
      tweetAt: doc.tweetAt || "",
      displayName: doc.displayName || "",
      handle: doc.handle || "",
      avatarUrl: doc.avatarUrl || "",
      imageUrls: doc.imageUrls || [],
      contentLinks: doc.contentLinks || [],
      quotedTweetUrl: doc.quotedTweetUrl || "",
      cardLink: doc.cardLink || "",
      parentTweetUrl: doc.parentTweetUrl || "",
    },
    info: {
      id: entry.id,
      collectedAt: entry.collectedAt,
      scrapeDate: entry.collectedAt ? entry.collectedAt.slice(0, 10) : "",
      scrapeHour: entry.collectedAt ? new Date(entry.collectedAt).getHours() : 0,
      tweetHour: doc.tweetHour || 0,
      hasScreenshot: entry.hasScreenshot,
      tags: doc.info?.tags,
    },
  }
}

/**
 * Slim variant for list views — omits verbose fields (contentLinks, imageUrls,
 * articleHtml) that are not needed for card rendering. ~9x smaller per item.
 */
export function stripVerbose(entry: CacheEntry): XItem {
  const item = stripScreenshot(entry)
  item.rawData.contentLinks = []
  item.rawData.imageUrls = []
  return item
}

export async function loadCache(db: Client): Promise<XCache | null> {
  const now = Date.now()
  if (cache && (now - lastCacheTime) < CACHE_TTL_MS) return cache

  try {
    const t0 = Date.now()
    // Exclude screenshot data from cache load — screenshots are fetched individually via /:id/screenshot
    const result = await db.execute(
      "SELECT id, json_remove(doc, '$.screenshot') AS doc, CASE WHEN json_extract(doc, '$.screenshot') IS NOT NULL AND json_extract(doc, '$.screenshot') != '' THEN 1 ELSE 0 END AS has_screenshot FROM documents WHERE json_extract(doc, '$.type') = 'x'",
    )
    const queryMs = Date.now() - t0

    const docsToClean: Array<{ id: string; doc: XDocument }> = []
    const entries: CacheEntry[] = result.rows.map((row: any) => {
      let doc: XDocument
      try {
        doc = typeof row.doc === "string" ? JSON.parse(row.doc) : row.doc
      } catch {
        doc = {} as XDocument
      }

      // Strip backlog: prefix from tags in-memory and collect for async DB write-back
      if (doc.info?.tags && Array.isArray(doc.info.tags)) {
        let changed = false
        doc.info.tags = doc.info.tags.map((t) => {
          if (t.startsWith("backlog:")) {
            changed = true
            return t.slice("backlog:".length)
          }
          return t
        })
        if (changed) {
          docsToClean.push({ id: String(row.id || ""), doc })
        }
      }

      return {
        doc,
        id: String(row.id || ""),
        collectedAt: doc.collectedAt || "",
        hasScreenshot: !!row.has_screenshot,
      }
    })

    // Build sorted indices
    const byPostDate = entries
      .map((_, i) => i)
      .sort((a, b) => {
        const tA = new Date(entries[a].doc.tweetAt || 0 as any).getTime()
        const tB = new Date(entries[b].doc.tweetAt || 0 as any).getTime()
        return tB - tA
      })

    const byCollectedAt = entries
      .map((_, i) => i)
      .sort((a, b) => {
        const tA = new Date(entries[a].collectedAt || 0 as any).getTime()
        const tB = new Date(entries[b].collectedAt || 0 as any).getTime()
        return tB - tA
      })

    // Build lookup maps
    const urlIndex: Record<string, number> = {}
    const idIndex: Record<string, number> = {}
    for (let i = 0; i < entries.length; i++) {
      const url = buildUrl(entries[i].doc)
      urlIndex[url] = i
      idIndex[entries[i].id] = i
      // Also index by bare tweetId
      if (entries[i].doc.tweetId) {
        idIndex[entries[i].doc.tweetId] = i
      }
    }

    cacheError = null
    lastCacheTime = now
    cache = { entries, byPostDate, byCollectedAt, urlIndex, idIndex }
    log.debug("Cache built: " + entries.length + " items in " + queryMs + "ms")

    // Async write-back: clean prefixed tags in DB without blocking the response
    if (docsToClean.length > 0 && !cleanupInProgress) {
      cleanupInProgress = true
      log.info(`Cleaning backlog: prefix from ${docsToClean.length} documents (async)`)
      ;(async () => {
        try {
          for (const { id, doc } of docsToClean) {
            try {
              await db.execute({
                sql: "UPDATE documents SET doc = json(?) WHERE id = ?",
                args: [JSON.stringify(doc), id],
              })
            } catch (e: any) {
              log.warn("Failed to clean prefix for " + id + ": " + (e.message || e))
            }
          }
          log.info(`Prefix cleanup complete: ${docsToClean.length} documents updated`)
        } finally {
          cleanupInProgress = false
        }
      })()
    }

    return cache
  } catch (e: any) {
    cacheError = e
    log.warn("DB load error: " + (e.message || e))
    return null
  }
}

export function getCacheError(): string | null {
  return cacheError ? cacheError.message : null
}

export function invalidateCache(): void {
  lastCacheTime = 0
}

export function findEntry(
  c: XCache,
  query: { id?: string; tweetId?: string; url?: string },
): number | undefined {
  if (query.id) {
    // Try exact match first, then try as bare tweetId
    if (c.idIndex[query.id] !== undefined) return c.idIndex[query.id]
    // Try with "x:" prefix
    const prefixed = query.id.startsWith("x:") ? query.id : `x:${query.id}`
    if (c.idIndex[prefixed] !== undefined) return c.idIndex[prefixed]
    return undefined
  }
  if (query.tweetId) return c.idIndex[query.tweetId]
  if (query.url) return c.urlIndex[query.url]
  return undefined
}

export function filterByDateRange(
  c: XCache,
  indices: number[],
  field: "tweetAt" | "collectedAt",
  from: string,
  to: string,
): number[] {
  return indices.filter((i) => {
    const doc = c.entries[i].doc
    const val = field === "tweetAt" ? (doc.tweetAt || "") : (c.entries[i].collectedAt || "")
    return val >= from && val <= to
  })
}

export function filterByUser(
  c: XCache,
  indices: number[],
  user: string,
): number[] {
  const lower = user.toLowerCase()
  return indices.filter((i) => {
    const doc = c.entries[i].doc
    return (doc.handle || "").toLowerCase().includes(lower) ||
           (doc.displayName || "").toLowerCase().includes(lower)
  })
}

export function searchEntries(
  c: XCache,
  indices: number[],
  q: string,
): number[] {
  const lower = q.toLowerCase()
  return indices.filter((i) => {
    const doc = c.entries[i].doc
    if ((doc.text || "").toLowerCase().includes(lower)) return true
    if (buildUrl(doc).toLowerCase().includes(lower)) return true
    if ((doc.handle || "").toLowerCase().includes(lower)) return true
    if ((doc.displayName || "").toLowerCase().includes(lower)) return true
    if ((doc.quotedTweetUrl || "").toLowerCase().includes(lower)) return true
    if ((doc.cardLink || "").toLowerCase().includes(lower)) return true
    if (doc.contentLinks && doc.contentLinks.length > 0) {
      for (const cl of doc.contentLinks) {
        if ((cl.url || "").toLowerCase().includes(lower)) return true
        if ((cl.text || "").toLowerCase().includes(lower)) return true
      }
    }
    return false
  })
}
