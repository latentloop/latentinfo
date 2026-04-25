/**
 * In-memory GitHub document cache with 5s TTL.
 */

import type { Client } from "@libsql/client"
import type { GithubDocument } from "../../collectors/github/types.js"
import type { GithubItem } from "./types.js"
import { createLogger } from "../../logger.js"

const log = createLogger("github-cache")
const README_PREVIEW_CHARS = 1800

interface CacheEntry {
  doc: GithubDocument
  id: string
  collectedAt: string
}

export interface GithubCache {
  entries: CacheEntry[]
  byCollectedAt: number[]
  byRepo: number[]
}

let cache: GithubCache | null = null
let cacheError: string | null = null
let cacheTs = 0
const CACHE_TTL_MS = 5000

function parseDoc(rowDoc: string | Record<string, unknown>): GithubDocument {
  return typeof rowDoc === "string"
    ? JSON.parse(rowDoc) as GithubDocument
    : rowDoc as unknown as GithubDocument
}

function buildCache(rows: Array<{ id: string; doc: string | Record<string, unknown> }>): GithubCache {
  const entries: CacheEntry[] = []

  for (const row of rows) {
    const doc = parseDoc(row.doc)
    entries.push({
      doc,
      id: row.id,
      collectedAt: doc.collectedAt || "",
    })
  }

  const byCollectedAt = entries.map((_, i) => i)
  byCollectedAt.sort((a, b) => {
    const tA = new Date(entries[a]!.collectedAt || 0 as any).getTime()
    const tB = new Date(entries[b]!.collectedAt || 0 as any).getTime()
    return tB - tA
  })

  const byRepo = entries.map((_, i) => i)
  byRepo.sort((a, b) => entries[a]!.doc.fullName.localeCompare(entries[b]!.doc.fullName))

  return { entries, byCollectedAt, byRepo }
}

export function invalidateCache(): void {
  cacheTs = 0
}

function readmePreview(markdown: string): string {
  const trimmed = markdown.trim()
  if (trimmed.length <= README_PREVIEW_CHARS) return trimmed
  return trimmed.slice(0, README_PREVIEW_CHARS).trimEnd()
}

export async function loadCache(db: Client): Promise<GithubCache | null> {
  if (cache && Date.now() - cacheTs < CACHE_TTL_MS) return cache
  try {
    const result = await db.execute({
      sql: "SELECT id, json_remove(doc, '$.readmeImages') AS doc FROM documents WHERE id LIKE 'github:%' ORDER BY id",
      args: [],
    })
    cache = buildCache(result.rows as any)
    cacheError = null
    cacheTs = Date.now()
    return cache
  } catch (e: any) {
    cacheError = e.message || "Failed to load github cache"
    log.error(e, "Failed to load github cache")
    return null
  }
}

export function getCacheError(): string | null {
  return cacheError
}

export function toItem(entry: CacheEntry, options: { full?: boolean } = {}): GithubItem {
  const doc = entry.doc
  const full = options.full === true
  const readmeMarkdown = doc.readmeMarkdown || ""
  const readmeText = doc.readmeText || readmeMarkdown
  const previewMarkdown = full ? readmeMarkdown : readmePreview(readmeMarkdown)
  const previewText = full ? readmeText : readmePreview(readmeText)
  return {
    rawData: {
      owner: doc.owner,
      repo: doc.repo,
      fullName: doc.fullName,
      description: doc.description,
      defaultBranch: doc.defaultBranch,
      stars: doc.stars,
      forks: doc.forks,
      language: doc.language,
      readmePath: doc.readmePath,
      readmeSha: doc.readmeSha,
      readmeMarkdown: previewMarkdown,
      readmeText: previewText,
      readmeImages: full ? (doc.readmeImages || []) : [],
      readmeImagesLoaded: full,
      readmeLength: readmeMarkdown.length,
      readmeTruncated: !full && (readmeMarkdown.trim().length > previewMarkdown.length || readmeText.trim().length > previewText.length),
      htmlUrl: doc.htmlUrl,
      rawUrl: doc.rawUrl,
      url: doc.url,
    },
    info: {
      id: entry.id,
      collectedAt: entry.collectedAt,
    },
  }
}

export function itemFromDoc(id: string, doc: GithubDocument): GithubItem {
  return toItem({
    id,
    doc,
    collectedAt: doc.collectedAt || "",
  }, { full: true })
}

export function filterByDateRange(
  c: GithubCache,
  indices: number[],
  from: string,
  to: string,
): number[] {
  return indices.filter((i) => {
    const val = c.entries[i]!.collectedAt || ""
    if (from && val < from) return false
    if (to && val > to) return false
    return true
  })
}

export function filterByOwner(
  c: GithubCache,
  indices: number[],
  owner: string,
): number[] {
  const lower = owner.toLowerCase().replace(/^@/, "")
  return indices.filter((i) => c.entries[i]!.doc.owner.toLowerCase().includes(lower))
}

export function searchEntries(c: GithubCache, indices: number[], q: string): number[] {
  const lower = q.toLowerCase()
  return indices.filter((i) => {
    const doc = c.entries[i]!.doc
    if (doc.fullName.toLowerCase().includes(lower)) return true
    if (doc.description.toLowerCase().includes(lower)) return true
    if (doc.language.toLowerCase().includes(lower)) return true
    if (doc.readmeMarkdown.toLowerCase().includes(lower)) return true
    return false
  })
}
