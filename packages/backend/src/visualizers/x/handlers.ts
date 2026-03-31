/**
 * X visualizer API route handlers.
 *
 * Routes (path is after /api/v1/x prefix strip):
 * - GET /           → list posts with pagination, search, date mode, sort
 * - GET /:id        → single post by document ID
 * - GET /:id/screenshot → screenshot as base64 data URI
 * - POST /tags/promote  → promote a backlog tag to confirmed
 */

import type { IncomingMessage, ServerResponse } from "node:http"
import { readFileSync, writeFileSync, statSync } from "node:fs"
import { join } from "node:path"
import type { Client } from "@libsql/client"
import { loadCache, getCacheError, findEntry, searchEntries, filterByDateRange, filterByUser, stripScreenshot, stripVerbose, invalidateCache } from "./cache.js"
import type { XListResponse } from "./types.js"
import { getProfileDir } from "../../config.js"
import { createLogger } from "../../logger.js"

const log = createLogger("x-handlers")

// Cached tag registry — re-parsed only when prompt.md mtime changes
let tagRegistryCache: { mtime: number; tags: string[]; backlogTags: string[] } | null = null

const MAX_BODY_BYTES = 1024 * 1024

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.destroy()
        reject(new Error("Request body too large"))
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")))
    req.on("error", reject)
  })
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(data))
}

export async function handleXApi(
  path: string,
  query: URLSearchParams,
  req: IncomingMessage,
  res: ServerResponse,
  db: Client,
): Promise<void> {
  // Normalize path: ensure leading slash, remove trailing slash
  const normalizedPath = ("/" + path.replace(/^\/+/, "")).replace(/\/+$/, "") || "/"
  const method = (req.method || "GET").toUpperCase()

  // GET / → list posts
  if (normalizedPath === "/" || normalizedPath === "") {
    const cache = await loadCache(db)
    if (!cache) {
      sendJson(res, 500, { error: getCacheError() || "DB not available" })
      return
    }

    const offset = Math.max(0, parseInt(query.get("offset") || "0", 10) || 0)
    const limit = Math.min(5000, Math.max(1, parseInt(query.get("limit") || "1000", 10) || 1000))
    const dateMode = query.get("dateMode") || "post_date"
    const sort = query.get("sort") || "desc"
    const q = (query.get("q") || "").trim()

    let indices = dateMode === "scrape_date" ? cache.byCollectedAt : cache.byPostDate

    // Reverse for ascending sort
    if (sort === "asc") {
      indices = [...indices].reverse()
    }

    // User filter
    const userFilter = (query.get("user") || "").trim()
    if (userFilter) {
      indices = filterByUser(cache, indices, userFilter)
    }

    // Date range filter
    const dateField = query.get("dateField") as "tweetAt" | "collectedAt" | null
    const dateFrom = query.get("dateFrom") || ""
    const dateTo = query.get("dateTo") || ""
    if (dateField && dateFrom && dateTo) {
      indices = filterByDateRange(cache, indices, dateField, dateFrom, dateTo)
    }

    if (q) {
      indices = searchEntries(cache, indices, q)
    }

    // Tag filter
    const tagFilter = (query.get("tag") || "").trim()
    if (tagFilter) {
      indices = indices.filter((i) => {
        const tags = cache.entries[i].doc.info?.tags
        return Array.isArray(tags) && tags.includes(tagFilter)
      })
    }

    const total = indices.length
    const page = indices.slice(offset, offset + limit)
    const slim = query.get("slim") === "true"
    const items = page.map((i) => slim ? stripVerbose(cache.entries[i]) : stripScreenshot(cache.entries[i]))

    const response: XListResponse = { items, total, offset, limit }
    sendJson(res, 200, response)
    return
  }

  // GET /tags → return confirmed and backlog tag lists from prompt.md (mtime-cached)
  if (normalizedPath === "/tags" && method === "GET") {
    const promptPath = join(getProfileDir(), "jobs", "x_tag", "prompt.md")
    try {
      const mtime = statSync(promptPath).mtimeMs
      if (tagRegistryCache && tagRegistryCache.mtime === mtime) {
        sendJson(res, 200, { tags: tagRegistryCache.tags, backlogTags: tagRegistryCache.backlogTags })
        return
      }

      const content = readFileSync(promptPath, "utf-8")
      const tagsMatch = content.match(/<!-- TAGS_START -->([\s\S]*?)<!-- TAGS_END -->/)
      const backlogMatch = content.match(/<!-- BACKLOG_START -->([\s\S]*?)<!-- BACKLOG_END -->/)

      const parseNames = (section: string): string[] =>
        section.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- "))
          .map((l) => l.slice(2).split(/\s+[—–-]\s+/)[0]!.trim())
          .filter(Boolean)

      const tags = tagsMatch ? parseNames(tagsMatch[1]!) : []
      const backlogTags = backlogMatch ? parseNames(backlogMatch[1]!) : []
      tagRegistryCache = { mtime, tags, backlogTags }

      sendJson(res, 200, { tags, backlogTags })
    } catch (e: any) {
      sendJson(res, 500, { error: "Failed to read prompt.md: " + (e.message || e) })
    }
    return
  }

  // POST /tags/promote → promote a backlog tag to confirmed
  if (normalizedPath === "/tags/promote" && method === "POST") {
    try {
      const body = await readBody(req)
      const { tag } = JSON.parse(body) as { tag?: string }
      if (!tag || typeof tag !== "string") {
        sendJson(res, 400, { error: "tag is required" })
        return
      }

      const promptPath = join(getProfileDir(), "jobs", "x_tag", "prompt.md")
      let content: string
      try {
        content = readFileSync(promptPath, "utf-8")
      } catch (e: any) {
        sendJson(res, 500, { error: "Failed to read prompt.md: " + (e.message || e) })
        return
      }

      // Parse sections
      const tagsStartMarker = "<!-- TAGS_START -->"
      const tagsEndMarker = "<!-- TAGS_END -->"
      const backlogStartMarker = "<!-- BACKLOG_START -->"
      const backlogEndMarker = "<!-- BACKLOG_END -->"

      const tagsStartIdx = content.indexOf(tagsStartMarker)
      const tagsEndIdx = content.indexOf(tagsEndMarker)
      const backlogStartIdx = content.indexOf(backlogStartMarker)
      const backlogEndIdx = content.indexOf(backlogEndMarker)

      if (tagsStartIdx === -1 || tagsEndIdx === -1 || backlogStartIdx === -1 || backlogEndIdx === -1) {
        sendJson(res, 500, { error: "prompt.md is missing required marker comments" })
        return
      }

      const tagsSection = content.slice(tagsStartIdx + tagsStartMarker.length, tagsEndIdx)
      const backlogSection = content.slice(backlogStartIdx + backlogStartMarker.length, backlogEndIdx)

      // Parse tag lines (format: "- tagname" or "- tagname — description")
      const parseTagLines = (section: string): string[] =>
        section.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- "))

      const confirmedLines = parseTagLines(tagsSection)
      const backlogLines = parseTagLines(backlogSection)

      const confirmedTags = confirmedLines.map((l) => l.slice(2).split(/\s+[—–-]\s+/)[0]!.trim())
      const backlogTags = backlogLines.map((l) => l.slice(2).split(/\s+[—–-]\s+/)[0]!.trim())

      if (confirmedTags.includes(tag)) {
        // Already confirmed — no-op
        sendJson(res, 200, { ok: true })
        return
      }

      const backlogIdx = backlogTags.indexOf(tag)
      if (backlogIdx === -1) {
        sendJson(res, 404, { error: `Tag "${tag}" not found in confirmed or backlog sections` })
        return
      }

      // Move the line from backlog to confirmed
      const promotedLine = backlogLines[backlogIdx]!
      const newBacklogLines = backlogLines.filter((_, i) => i !== backlogIdx)
      const newConfirmedLines = [...confirmedLines, promotedLine]

      // Rebuild content
      const newTagsSection = "\n" + newConfirmedLines.join("\n") + "\n"
      const newBacklogSection = newBacklogLines.length > 0
        ? "\n" + newBacklogLines.join("\n") + "\n"
        : "\n"

      let updated = content.slice(0, tagsStartIdx + tagsStartMarker.length) +
        newTagsSection +
        content.slice(tagsEndIdx)

      // Recalculate backlog indices after tags section change
      const newBacklogStartIdx = updated.indexOf(backlogStartMarker)
      const newBacklogEndIdx = updated.indexOf(backlogEndMarker)
      updated = updated.slice(0, newBacklogStartIdx + backlogStartMarker.length) +
        newBacklogSection +
        updated.slice(newBacklogEndIdx)

      writeFileSync(promptPath, updated, "utf-8")
      log.info({ tag }, "Promoted tag from backlog to confirmed")

      // Invalidate cache and notify SSE clients
      invalidateCache()
      const { broadcastSseEvent } = await import("../../server.js")
      broadcastSseEvent("data-changed", { source: "x", reason: "tags" })

      sendJson(res, 200, { ok: true })
    } catch (e: any) {
      sendJson(res, 400, { error: e.message || "Invalid request body" })
    }
    return
  }

  // Match /:id/screenshot — query directly from DB to avoid loading the full cache
  const screenshotMatch = normalizedPath.match(/^\/(.+)\/screenshot$/)
  if (screenshotMatch) {
    const rawId = decodeURIComponent(screenshotMatch[1]!)
    // Normalize: try as-is, then with "x:" prefix
    const ids = rawId.startsWith("x:") ? [rawId] : [rawId, `x:${rawId}`]
    let screenshot: string | null = null
    for (const tryId of ids) {
      const result = await db.execute({
        sql: "SELECT json_extract(doc, '$.screenshot') AS screenshot FROM documents WHERE id = ?",
        args: [tryId],
      })
      const row = result.rows[0] as { screenshot?: string } | undefined
      if (row?.screenshot && row.screenshot !== "") {
        screenshot = row.screenshot
        break
      }
    }
    sendJson(res, 200, { screenshot })
    return
  }

  // Match /:id → single post
  const idMatch = normalizedPath.match(/^\/(.+)$/)
  if (idMatch) {
    const id = decodeURIComponent(idMatch[1]!)
    const cache = await loadCache(db)
    if (!cache) {
      sendJson(res, 500, { error: getCacheError() || "DB not available" })
      return
    }

    const idx = findEntry(cache, { id })
    if (idx === undefined) {
      sendJson(res, 404, { error: "Not found" })
      return
    }

    const item = stripScreenshot(cache.entries[idx])
    sendJson(res, 200, { item })
    return
  }

  sendJson(res, 404, { error: "Not found" })
}
