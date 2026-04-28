/**
 * X visualizer API route handlers.
 *
 * Routes (path is after /api/v1/x prefix strip):
 * - GET /           → list posts with pagination, search, date mode, sort
 * - GET /summary    → lightweight archive count
 * - GET /:id        → single post by document ID
 * - GET /:id/screenshot → screenshot as base64 data URI
 * - POST /tags/promote  → promote a backlog tag to confirmed
 */

import { readFileSync, writeFileSync, statSync } from "node:fs"
import { join } from "node:path"
import type { Client } from "@libsql/client"
import { loadCache, getCacheError, searchEntries, filterByDateRange, filterByUser, stripScreenshot, stripVerbose, invalidateCache, itemFromDoc, normalizeBacklogTagPrefixes } from "./cache.js"
import type { XDocument, XItem, XListResponse, XSummaryResponse } from "./types.js"
import { getProfileDir } from "../../config.js"
import { createLogger } from "../../logger.js"
import { emitBackendEvent } from "../../events.js"
import { jsonResponse, readTextBody, type ApiRequest } from "../../server.js"

const log = createLogger("x-handlers")

// Cached tag registry — re-parsed only when prompt.md mtime changes
let tagRegistryCache: { mtime: number; tags: string[]; backlogTags: string[] } | null = null

function parseXDoc(rowDoc: string | Record<string, unknown>): XDocument {
  return typeof rowDoc === "string"
    ? JSON.parse(rowDoc) as XDocument
    : rowDoc as unknown as XDocument
}

function dateExpr(field: "collectedAt" | "tweetAt"): string {
  return `json_extract(doc, '$.${field}')`
}

async function hydrateFullPageItems(
  db: Client,
  entries: Array<{ id: string; doc: XDocument; collectedAt: string; hasScreenshot: boolean }>,
): Promise<XItem[]> {
  if (entries.length === 0) return []

  const ids = entries.map((entry) => entry.id)
  const result = await db.execute({
    sql: `SELECT id, json_remove(doc, '$.screenshot') AS doc, CASE WHEN json_extract(doc, '$.screenshot') IS NOT NULL AND json_extract(doc, '$.screenshot') != '' THEN 1 ELSE 0 END AS has_screenshot FROM documents WHERE id IN (${ids.map(() => "?").join(",")})`,
    args: ids,
  })
  const byId = new Map<string, XItem>()
  for (const row of result.rows as Array<{ id?: string; doc?: string | Record<string, unknown>; has_screenshot?: number }>) {
    if (!row.id || !row.doc) continue
    const doc = parseXDoc(row.doc)
    normalizeBacklogTagPrefixes(doc)
    byId.set(row.id, itemFromDoc(row.id, doc, !!row.has_screenshot))
  }

  return entries.map((entry) => byId.get(entry.id) ?? stripScreenshot(entry))
}

export async function handleXApi(
  path: string,
  query: URLSearchParams,
  request: ApiRequest,
  db: Client,
): Promise<Response> {
  // Normalize path: ensure leading slash, remove trailing slash
  const normalizedPath = ("/" + path.replace(/^\/+/, "")).replace(/\/+$/, "") || "/"
  const method = request.method.toUpperCase()

  // GET /summary → exact archive count. Kept separate so list/range requests
  // can stream pages without paying count cost on every request.
  if (normalizedPath === "/summary" && method === "GET") {
    const result = await db.execute(
      "SELECT COUNT(*) AS cnt FROM documents WHERE json_extract(doc, '$.type') = 'x'",
    )
    const response: XSummaryResponse = {
      total: Number(result.rows[0]?.cnt ?? 0),
    }
    return jsonResponse(200, response)
  }

  // GET / → list posts
  if (normalizedPath === "/" || normalizedPath === "") {
    const offset = Math.max(0, parseInt(query.get("offset") || "0", 10) || 0)
    const limit = Math.min(5000, Math.max(1, parseInt(query.get("limit") || "1000", 10) || 1000))
    const dateMode = query.get("dateMode") || "post_date"
    const sort = query.get("sort") || "desc"
    const q = (query.get("q") || "").trim()

    // SQL page path for unfiltered date-order/range views. It avoids hydrating
    // the full X cache and uses limit+1 to derive hasMore without COUNT(*).
    const userFilter = (query.get("user") || "").trim()
    const dateField = query.get("dateField") as "tweetAt" | "collectedAt" | null
    const dateFrom = query.get("dateFrom") || ""
    const dateTo = query.get("dateTo") || ""
    const tagFilter = (query.get("tag") || "").trim()
    const orderField = dateMode === "scrape_date" ? "collectedAt" : "tweetAt"
    const rangeField = dateField === "collectedAt" || dateField === "tweetAt" ? dateField : null
    const canUseSqlPage =
      !q &&
      !userFilter &&
      !tagFilter

    if (canUseSqlPage) {
      const where: string[] = ["json_extract(doc, '$.type') = 'x'"]
      const whereArgs: Array<string | number> = []
      if (rangeField) {
        if (dateFrom) {
          where.push(`${dateExpr(rangeField)} >= ?`)
          whereArgs.push(dateFrom)
        }
        if (dateTo) {
          where.push(`${dateExpr(rangeField)} <= ?`)
          whereArgs.push(dateTo)
        }
      }
      const whereClause = where.join(" AND ")
      const direction = sort === "asc" ? "ASC" : "DESC"
      const orderExpr = dateExpr(orderField)
      const indexName = orderField === "collectedAt" ? "idx_doc_x_collected_at" : "idx_doc_x_tweet_at"
      const slim = query.get("slim") === "true"
      const docSelect = slim
        ? "json_remove(doc, '$.screenshot', '$.avatarUrl', '$.imageUrls', '$.articleHtml') AS doc"
        : "json_remove(doc, '$.screenshot') AS doc"
      const pageResult = await db.execute({
        sql: `SELECT id, ${docSelect}, CASE WHEN json_extract(doc, '$.screenshot') IS NOT NULL AND json_extract(doc, '$.screenshot') != '' THEN 1 ELSE 0 END AS has_screenshot FROM documents INDEXED BY ${indexName} WHERE ${whereClause} ORDER BY ${orderExpr} ${direction} LIMIT ? OFFSET ?`,
        args: [...whereArgs, limit + 1, offset],
      })
      const rows = pageResult.rows.slice(0, limit)
      const items = rows.map((row: any) => {
        const doc = parseXDoc(row.doc)
        normalizeBacklogTagPrefixes(doc)
        const item = itemFromDoc(String(row.id || ""), doc, !!row.has_screenshot)
        if (slim) {
          item.rawData.contentLinks = []
          item.rawData.imageUrls = []
        }
        return item
      })
      const response: XListResponse = {
        items,
        offset,
        limit,
        hasMore: pageResult.rows.length > limit,
      }
      return jsonResponse(200, response)
    }

    const cache = await loadCache(db)
    if (!cache) {
      return jsonResponse(500, { error: getCacheError() || "DB not available" })
    }

    let indices = dateMode === "scrape_date" ? cache.byCollectedAt : cache.byPostDate

    // Reverse for ascending sort
    if (sort === "asc") {
      indices = [...indices].reverse()
    }

    // User filter
    if (userFilter) {
      indices = filterByUser(cache, indices, userFilter)
    }

    // Date range filter
    if (dateField && (dateFrom || dateTo)) {
      indices = filterByDateRange(cache, indices, dateField, dateFrom, dateTo)
    }

    if (q) {
      indices = searchEntries(cache, indices, q)
    }

    // Tag filter
    if (tagFilter) {
      indices = indices.filter((i) => {
        const tags = cache.entries[i].doc.info?.tags
        return Array.isArray(tags) && tags.includes(tagFilter)
      })
    }

    const page = indices.slice(offset, offset + limit + 1)
    const slim = query.get("slim") === "true"
    const pageEntries = page.slice(0, limit).map((i) => cache.entries[i])
    const items = slim
      ? pageEntries.map((entry) => stripVerbose(entry))
      : await hydrateFullPageItems(db, pageEntries)

    const response: XListResponse = {
      items,
      offset,
      limit,
      hasMore: page.length > limit,
    }
    return jsonResponse(200, response)
  }

  // GET /tags → return confirmed and backlog tag lists from prompt.md (mtime-cached)
  if (normalizedPath === "/tags" && method === "GET") {
    const promptPath = join(getProfileDir(), "jobs", "x_tag", "prompt.md")
    try {
      const mtime = statSync(promptPath).mtimeMs
      if (tagRegistryCache && tagRegistryCache.mtime === mtime) {
        return jsonResponse(200, { tags: tagRegistryCache.tags, backlogTags: tagRegistryCache.backlogTags })
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

      return jsonResponse(200, { tags, backlogTags })
    } catch (e: any) {
      return jsonResponse(500, { error: "Failed to read prompt.md: " + (e.message || e) })
    }
  }

  // POST /tags/promote → promote a backlog tag to confirmed
  if (normalizedPath === "/tags/promote" && method === "POST") {
    try {
      const body = await readTextBody(request)
      const { tag } = JSON.parse(body) as { tag?: string }
      if (!tag || typeof tag !== "string") {
        return jsonResponse(400, { error: "tag is required" })
      }

      const promptPath = join(getProfileDir(), "jobs", "x_tag", "prompt.md")
      let content: string
      try {
        content = readFileSync(promptPath, "utf-8")
      } catch (e: any) {
        return jsonResponse(500, { error: "Failed to read prompt.md: " + (e.message || e) })
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
        return jsonResponse(500, { error: "prompt.md is missing required marker comments" })
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
        return jsonResponse(200, { ok: true })
      }

      const backlogIdx = backlogTags.indexOf(tag)
      if (backlogIdx === -1) {
        return jsonResponse(404, { error: `Tag "${tag}" not found in confirmed or backlog sections` })
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

      // Invalidate cache and notify backend event subscribers
      invalidateCache()
      emitBackendEvent("data-changed", { source: "x", reason: "tags" })

      return jsonResponse(200, { ok: true })
    } catch (e: any) {
      return jsonResponse(400, { error: e.message || "Invalid request body" })
    }
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
    return jsonResponse(200, { screenshot })
  }

  // Match /:id → single post. Query directly so the list cache can stay slim.
  const idMatch = normalizedPath.match(/^\/(.+)$/)
  if (idMatch) {
    const rawId = decodeURIComponent(idMatch[1]!)
    const ids = rawId.startsWith("x:") ? [rawId] : [rawId, `x:${rawId}`]
    for (const id of ids) {
      const result = await db.execute({
        sql: "SELECT json_remove(doc, '$.screenshot') AS doc, CASE WHEN json_extract(doc, '$.screenshot') IS NOT NULL AND json_extract(doc, '$.screenshot') != '' THEN 1 ELSE 0 END AS has_screenshot FROM documents WHERE id = ? AND json_extract(doc, '$.type') = 'x' LIMIT 1",
        args: [id],
      })
      const row = result.rows[0] as { doc?: string | Record<string, unknown>; has_screenshot?: number } | undefined
      if (!row?.doc) continue
      const doc = parseXDoc(row.doc)
      return jsonResponse(200, { item: itemFromDoc(id, doc, !!row.has_screenshot) })
    }

    return jsonResponse(404, { error: "Not found" })
  }

  return jsonResponse(404, { error: "Not found" })
}
