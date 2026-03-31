/**
 * In-memory arxiv document cache with 5s TTL.
 */

import type { Client } from "@libsql/client"
import type { ArxivDocument } from "../../collectors/arxiv/types.js"
import type { ArxivItem } from "./types.js"
import { createLogger } from "../../logger.js"

const log = createLogger("arxiv-cache")

interface CacheEntry {
  doc: ArxivDocument
  id: string
  collectedAt: string
}

export interface ArxivCache {
  entries: CacheEntry[]
  byCollectedAt: number[]
  bySubmittedAt: number[]
}

let cache: ArxivCache | null = null
let cacheError: string | null = null
let cacheTs = 0
const CACHE_TTL_MS = 5000

function buildCache(rows: Array<{ id: string; doc: string | Record<string, unknown> }>): ArxivCache {
  const entries: CacheEntry[] = []

  for (const row of rows) {
    const doc = typeof row.doc === "string" ? JSON.parse(row.doc) as ArxivDocument : row.doc as unknown as ArxivDocument
    entries.push({
      doc,
      id: row.id as string,
      collectedAt: doc.collectedAt || "",
    })
  }

  const byCollectedAt = entries.map((_, i) => i)
  byCollectedAt.sort((a, b) => {
    const tA = new Date(entries[a]!.collectedAt || 0 as any).getTime()
    const tB = new Date(entries[b]!.collectedAt || 0 as any).getTime()
    return tB - tA
  })

  const bySubmittedAt = entries.map((_, i) => i)
  bySubmittedAt.sort((a, b) => {
    const tA = new Date(entries[a]!.doc.submittedAt || 0 as any).getTime()
    const tB = new Date(entries[b]!.doc.submittedAt || 0 as any).getTime()
    return tB - tA
  })

  return { entries, byCollectedAt, bySubmittedAt }
}

export function invalidateCache(): void {
  cacheTs = 0
}

export async function loadCache(db: Client): Promise<ArxivCache | null> {
  if (cache && Date.now() - cacheTs < CACHE_TTL_MS) return cache
  try {
    const result = await db.execute({
      sql: "SELECT id, doc FROM documents WHERE id LIKE 'arxiv:%' ORDER BY id",
      args: [],
    })
    cache = buildCache(result.rows as any)
    cacheError = null
    cacheTs = Date.now()
    return cache
  } catch (e: any) {
    cacheError = e.message || "Failed to load arxiv cache"
    log.error(e, "Failed to load arxiv cache")
    return null
  }
}

export function getCacheError(): string | null {
  return cacheError
}

export function toItem(entry: CacheEntry): ArxivItem {
  const doc = entry.doc
  const info = (doc as unknown as Record<string, unknown>).info as Record<string, unknown> | undefined
  return {
    rawData: {
      arxivId: doc.arxivId,
      title: doc.title,
      authors: doc.authors,
      abstract: doc.abstract,
      categories: doc.categories,
      submittedAt: doc.submittedAt,
      pdfUrl: doc.pdfUrl,
      url: doc.url,
      versions: doc.versions,
    },
    info: {
      id: entry.id,
      collectedAt: entry.collectedAt,
      downloadPath: info?.downloadPath as string | undefined,
    },
  }
}

export function filterByDateRange(
  c: ArxivCache,
  indices: number[],
  field: "submittedAt" | "collectedAt",
  from: string,
  to: string,
): number[] {
  return indices.filter((i) => {
    const val = field === "submittedAt" ? (c.entries[i]!.doc.submittedAt || "") : (c.entries[i]!.collectedAt || "")
    return val >= from && val <= to
  })
}

export function filterByUser(
  c: ArxivCache,
  indices: number[],
  user: string,
): number[] {
  const lower = user.toLowerCase()
  return indices.filter((i) => {
    for (const a of c.entries[i]!.doc.authors) {
      if (a.toLowerCase().includes(lower)) return true
    }
    return false
  })
}

export function searchEntries(c: ArxivCache, indices: number[], q: string): number[] {
  const lower = q.toLowerCase()
  return indices.filter((i) => {
    const doc = c.entries[i]!.doc
    if (doc.title.toLowerCase().includes(lower)) return true
    if (doc.abstract.toLowerCase().includes(lower)) return true
    if (doc.arxivId.toLowerCase().includes(lower)) return true
    for (const a of doc.authors) {
      if (a.toLowerCase().includes(lower)) return true
    }
    for (const cat of doc.categories) {
      if (cat.toLowerCase().includes(lower)) return true
    }
    return false
  })
}
