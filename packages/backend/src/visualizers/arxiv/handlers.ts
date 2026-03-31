/**
 * arxiv visualizer API route handlers.
 *
 * Routes (path is after /api/v1/arxiv prefix strip):
 * - GET /  → list papers with pagination, search, sort
 */

import type { IncomingMessage, ServerResponse } from "node:http"
import type { Client } from "@libsql/client"
import { loadCache, getCacheError, searchEntries, filterByDateRange, filterByUser, toItem } from "./cache.js"
import type { ArxivListResponse } from "./types.js"

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
    "Access-Control-Allow-Origin": "*",
  })
  res.end(json)
}

export function handleArxivApi(
  path: string,
  query: URLSearchParams,
  req: IncomingMessage,
  res: ServerResponse,
  db: Client,
): void {
  void (async () => {
    // GET / — list papers
    if ((path === "" || path === "/") && req.method === "GET") {
      const cache = await loadCache(db)
      if (!cache) {
        sendJson(res, 500, { error: getCacheError() || "DB not available" })
        return
      }

      const offset = Math.max(0, parseInt(query.get("offset") || "0", 10) || 0)
      const limit = Math.min(5000, Math.max(1, parseInt(query.get("limit") || "1000", 10) || 1000))
      const sort = query.get("sort") || "desc"
      const sortField = query.get("sortField") || "collectedAt"
      const q = (query.get("q") || "").trim()

      let indices = sortField === "submittedAt" ? cache.bySubmittedAt : cache.byCollectedAt

      if (sort === "asc") {
        indices = [...indices].reverse()
      }

      // User/author filter
      const userFilter = (query.get("user") || "").trim()
      if (userFilter) {
        indices = filterByUser(cache, indices, userFilter)
      }

      // Date range filter
      const dateField = query.get("dateField") as "submittedAt" | "collectedAt" | null
      const dateFrom = query.get("dateFrom") || ""
      const dateTo = query.get("dateTo") || ""
      if (dateField && dateFrom && dateTo) {
        indices = filterByDateRange(cache, indices, dateField, dateFrom, dateTo)
      }

      if (q) {
        indices = searchEntries(cache, indices, q)
      }

      const total = indices.length
      const page = indices.slice(offset, offset + limit)
      const items = page.map((i) => toItem(cache.entries[i]!))

      const response: ArxivListResponse = { items, total, offset, limit }
      sendJson(res, 200, response)
      return
    }

    sendJson(res, 404, { error: "Not found" })
  })()
}
