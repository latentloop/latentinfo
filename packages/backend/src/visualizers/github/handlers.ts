/**
 * GitHub visualizer API route handlers.
 *
 * Routes (path is after /api/v1/github prefix strip):
 * - GET /  → list repository READMEs with pagination and search
 * - GET /:id → full repository README payload
 */

import type { IncomingMessage, ServerResponse } from "node:http"
import type { Client } from "@libsql/client"
import { loadCache, getCacheError, searchEntries, filterByDateRange, filterByOwner, toItem, itemFromDoc } from "./cache.js"
import type { GithubListResponse } from "./types.js"
import type { GithubDocument } from "../../collectors/github/types.js"

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
    "Access-Control-Allow-Origin": "*",
  })
  res.end(json)
}

export function handleGithubApi(
  path: string,
  query: URLSearchParams,
  req: IncomingMessage,
  res: ServerResponse,
  db: Client,
): void {
  void (async () => {
    const normalizedPath = ("/" + path.replace(/^\/+/, "")).replace(/\/+$/, "") || "/"
    const method = (req.method || "GET").toUpperCase()

    if ((normalizedPath === "" || normalizedPath === "/") && method === "GET") {
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

      let indices = sortField === "repo" ? cache.byRepo : cache.byCollectedAt
      if (sort === "asc") {
        indices = [...indices].reverse()
      }

      const owner = (query.get("user") || query.get("owner") || "").trim()
      if (owner) {
        indices = filterByOwner(cache, indices, owner)
      }

      const dateFrom = query.get("dateFrom") || ""
      const dateTo = query.get("dateTo") || ""
      if (dateFrom || dateTo) {
        indices = filterByDateRange(cache, indices, dateFrom, dateTo)
      }

      if (q) {
        indices = searchEntries(cache, indices, q)
      }

      const total = indices.length
      const page = indices.slice(offset, offset + limit)
      const items = page.map((i) => toItem(cache.entries[i]!))

      const response: GithubListResponse = { items, total, offset, limit }
      sendJson(res, 200, response)
      return
    }

    const idMatch = normalizedPath.match(/^\/(.+)$/)
    if (idMatch && method === "GET") {
      const rawId = decodeURIComponent(idMatch[1]!)
      const ids = rawId.startsWith("github:") ? [rawId] : [rawId, `github:${rawId}`]
      for (const id of ids) {
        const result = await db.execute({
          sql: "SELECT id, doc FROM documents WHERE id = ? AND id LIKE 'github:%' LIMIT 1",
          args: [id],
        })
        const row = result.rows[0] as { id?: string; doc?: string | Record<string, unknown> } | undefined
        if (!row?.doc) continue
        const doc = typeof row.doc === "string" ? JSON.parse(row.doc) as GithubDocument : row.doc as unknown as GithubDocument
        sendJson(res, 200, { item: itemFromDoc(String(row.id || id), doc) })
        return
      }

      sendJson(res, 404, { error: "Not found" })
      return
    }

    sendJson(res, 404, { error: "Not found" })
  })()
}
