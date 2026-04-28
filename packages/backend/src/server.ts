/**
 * Embedded backend API router.
 *
 * This module intentionally does not open a TCP port. Electron calls
 * `handleRequest` from its custom protocol handler, and the CLI entry point can
 * reuse the same application service without a local HTTP server.
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { join, resolve, extname, sep } from "node:path"
import { fileURLToPath } from "node:url"
import type { Client } from "@libsql/client"
import { loadSettings, saveSettings, getBrowserIcon, type AppSettings, type BrowserEntry } from "./settings.js"
import { loadCollectorConfig, saveCollectorConfig, type CollectorSettings } from "./collector-config.js"
import { refreshSessions } from "./browser-monitor.js"
import { requestManualAttach, requestManualDetach } from "./attach-queue.js"
import { type CollectorDefinition } from "./collector-runner.js"
import { loadApps } from "./apps.js"
import { getAppErrors, clearAppErrors, getAllAppErrors, getClearFlag, setClearFlag, setOnCdpEvent } from "./app-runner.js"
import { getJobsInfo, getJobRuns, triggerManualRun, saveJobConfig, onJobEvent } from "./job-runner.js"
import { getSession, sendCommand } from "./cdp.js"
import { parseTweetIds } from "./utils/parse-tweet-ids.js"
import { parseArxivIds } from "./utils/parse-arxiv-ids.js"
import { setArticleDb, listArticles, getArticle, getArticleVersions, getArticleImage } from "./storage/article-db.js"
import { emitBackendEvent } from "./events.js"
import { createLogger } from "./logger.js"

const log = createLogger("api")

const VERSION = (() => {
  try {
    const thisDir = fileURLToPath(new URL(".", import.meta.url))
    const pkg = JSON.parse(readFileSync(join(thisDir, "..", "package.json"), "utf-8")) as { version?: string }
    return pkg.version || "dev"
  } catch {
    return "dev"
  }
})()

const startTime = Date.now()
const MAX_BODY_BYTES = 1024 * 1024

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
}

export type ApiRequest = Request

export interface VisualizerDefinition {
  id: string
  label: string
  initVisualizer?: (db: Client) => Promise<void>
  handleApi: (path: string, query: URLSearchParams, request: ApiRequest, db: Client) => Response | Promise<Response>
}

export interface BackendApiConfig {
  staticDir?: string
  db: Client
  visualizers: VisualizerDefinition[]
  browsers: BrowserEntry[]
  collectors: CollectorDefinition[]
  /** Called after settings are saved via PUT /api/v1/settings. */
  onSettingsChanged?: (prev: AppSettings, next: AppSettings) => void
}

export interface BackendApi {
  handleRequest(request: ApiRequest): Promise<Response>
  close(): void
}

export function jsonResponse(status: number, data: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers)
  headers.set("Content-Type", "application/json")
  return new Response(JSON.stringify(data), {
    ...init,
    status,
    headers,
  })
}

export async function readTextBody(request: ApiRequest): Promise<string> {
  const body = await request.text()
  if (Buffer.byteLength(body, "utf-8") > MAX_BODY_BYTES) {
    throw new Error("Request body too large")
  }
  return body
}

function documentIdRange(prefix: string): [string, string] {
  return [`${prefix}:`, `${prefix};`]
}

function withCors(request: ApiRequest, response: Response): Response {
  const headers = new Headers(response.headers)
  const origin = request.headers.get("origin")
  headers.set("Access-Control-Allow-Origin", origin || "*")
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
  headers.set("Access-Control-Allow-Headers", "Content-Type")
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function fileResponse(filePath: string): Response | null {
  try {
    if (!existsSync(filePath) || !statSync(filePath).isFile()) return null
    const content = readFileSync(filePath)
    const ext = extname(filePath)
    const headers = new Headers({
      "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
    })
    return new Response(new Uint8Array(content), { status: 200, headers })
  } catch {
    return null
  }
}

function staticFileResponse(staticDir: string, pathname: string): Response | null {
  const filePath = resolve(staticDir, "." + pathname)
  const resolvedBase = resolve(staticDir)
  if (!filePath.startsWith(resolvedBase + sep) && filePath !== resolvedBase) {
    return null
  }
  return fileResponse(filePath)
}

/** Strip sensitive env vars before launching a browser subprocess. */
function sanitizeEnvForBrowser(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env }
  const sensitivePatterns = [
    "LATENT_INFO_", "API_KEY", "SECRET", "TOKEN", "PASSWORD",
    "AWS_", "GOOGLE_APPLICATION_CREDENTIALS", "DATABASE_URL",
  ]
  for (const key of Object.keys(clean)) {
    if (sensitivePatterns.some((p) => key.toUpperCase().includes(p))) {
      delete clean[key]
    }
  }
  return clean
}

export async function createBackendApi(config: BackendApiConfig): Promise<BackendApi> {
  const { staticDir, db, visualizers, browsers, collectors, onSettingsChanged } = config

  setArticleDb(db)

  const vizMap = new Map<string, VisualizerDefinition>()
  for (const viz of visualizers) {
    vizMap.set(viz.id, viz)
  }

  setOnCdpEvent((sessionName, method, params) => {
    emitBackendEvent("cdp", { sessionName, method, params })
  })

  const cleanupJobStarted = onJobEvent("job:run-started", (payload) => {
    emitBackendEvent("jobs-updated", payload)
  })
  const cleanupJobCompleted = onJobEvent("job:run-completed", (payload) => {
    emitBackendEvent("jobs-updated", payload)
  })

  async function route(request: ApiRequest): Promise<Response> {
    const parsedUrl = new URL(request.url)
    const pathname = parsedUrl.pathname
    const method = request.method.toUpperCase()

    if (method === "OPTIONS") {
      return new Response(null, { status: 204 })
    }

    if (pathname === "/health") {
      return jsonResponse(200, { status: "ok" })
    }

    if (pathname === "/api/v1/status" && method === "GET") {
      let totalDocuments = 0
      let lastCollectionTime: string | null = null
      const collectorStats: { id: string; documentCount: number; lastCollectionTime: string | null }[] = []

      try {
        for (const viz of visualizers) {
          const [rangeStart, rangeEnd] = documentIdRange(viz.id)
          const [countResult, latestResult] = await Promise.all([
            db.execute({
              sql: "SELECT COUNT(*) AS cnt FROM documents WHERE id >= ? AND id < ?",
              args: [rangeStart, rangeEnd],
            }),
            db.execute({
              sql: "SELECT json_extract(doc, '$.collectedAt') AS latest_ca FROM documents INDEXED BY idx_doc_collected_at WHERE id >= ? AND id < ? ORDER BY json_extract(doc, '$.collectedAt') DESC LIMIT 1",
              args: [rangeStart, rangeEnd],
            }),
          ])
          const docCount = Number(countResult.rows[0]?.cnt ?? 0)
          const latestTime = (latestResult.rows[0]?.latest_ca as string | undefined) ?? null
          totalDocuments += docCount
          if (latestTime && (!lastCollectionTime || latestTime > lastCollectionTime)) {
            lastCollectionTime = latestTime
          }
          collectorStats.push({ id: viz.id, documentCount: docCount, lastCollectionTime: latestTime })
        }
      } catch (e: any) {
        log.warn({ err: e.message }, "Failed to aggregate document stats")
      }

      return jsonResponse(200, {
        version: VERSION,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        visualizers: visualizers.map((v) => ({ id: v.id, label: v.label })),
        totalDocuments,
        lastCollectionTime,
        collectors: collectorStats,
      })
    }

    if (pathname === "/api/v1/settings") {
      if (method === "GET") {
        return jsonResponse(200, loadSettings())
      }
      if (method === "PUT") {
        try {
          const update = JSON.parse(await readTextBody(request)) as Record<string, unknown>
          if (update.autoAttach !== undefined && typeof update.autoAttach !== "boolean") {
            return jsonResponse(400, { error: "autoAttach must be a boolean" })
          }
          if (update.browsers !== undefined && !Array.isArray(update.browsers)) {
            return jsonResponse(400, { error: "browsers must be an array" })
          }
          if (update.remoteDebuggingAutoAllow !== undefined && typeof update.remoteDebuggingAutoAllow !== "boolean") {
            return jsonResponse(400, { error: "remoteDebuggingAutoAllow must be a boolean" })
          }
          if (update.logLevel !== undefined && typeof update.logLevel !== "string") {
            return jsonResponse(400, { error: "logLevel must be a string" })
          }
          const allowedKeys = new Set(["autoAttach", "browsers", "remoteDebuggingAutoAllow", "logLevel", "collectors"])
          const unknownKeys = Object.keys(update).filter((k) => !allowedKeys.has(k))
          if (unknownKeys.length > 0) {
            return jsonResponse(400, { error: `Unknown settings keys: ${unknownKeys.join(", ")}` })
          }
          if (update.collectors && typeof update.collectors === "object") {
            for (const [id, cfg] of Object.entries(update.collectors as Record<string, CollectorSettings>)) {
              saveCollectorConfig(id, cfg)
            }
            delete update.collectors
          }
          const current = loadSettings()
          const merged = { ...current, ...update } as AppSettings
          saveSettings(merged)
          onSettingsChanged?.(current, merged)
          emitBackendEvent("settings-changed", {})
          return jsonResponse(200, merged)
        } catch (e: any) {
          return jsonResponse(400, { error: e.message || "Invalid request body" })
        }
      }
    }

    if (pathname === "/api/v1/sessions" && method === "GET") {
      return jsonResponse(200, { sessions: refreshSessions(browsers) })
    }

    if (pathname === "/api/v1/sessions/attach" && method === "POST") {
      try {
        const { sessionName } = JSON.parse(await readTextBody(request)) as { sessionName: string }
        if (!sessionName) return jsonResponse(400, { error: "sessionName is required" })
        const sessions = refreshSessions(browsers)
        const session = sessions.find((s) => s.sessionName === sessionName)
        if (!session) return jsonResponse(404, { error: "Session not found" })
        if (!session.cdpWsUrl) return jsonResponse(400, { error: "No CDP endpoint available for this session" })
        const ok = await requestManualAttach(sessionName, session.cdpWsUrl)
        return ok
          ? jsonResponse(200, { ok: true, sessionName })
          : jsonResponse(500, {
              ok: false,
              sessionName,
              error: `Could not connect to ${sessionName}. Remote debugging may not be enabled — check chrome://inspect or relaunch the browser with remote debugging allowed.`,
            })
      } catch (e: any) {
        return jsonResponse(400, { error: e.message || "Invalid request body" })
      }
    }

    if (pathname === "/api/v1/sessions/detach" && method === "POST") {
      try {
        const { sessionName } = JSON.parse(await readTextBody(request)) as { sessionName: string }
        if (!sessionName) return jsonResponse(400, { error: "sessionName is required" })
        requestManualDetach(sessionName)
        return jsonResponse(200, { ok: true, sessionName })
      } catch (e: any) {
        return jsonResponse(400, { error: e.message || "Invalid request body" })
      }
    }

    if (pathname === "/api/v1/open-accessibility-settings" && method === "POST") {
      try {
        execFileSync("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"], {
          timeout: 5000,
        })
        return jsonResponse(200, { ok: true })
      } catch (e: any) {
        return jsonResponse(500, { error: e.message || "Failed to open Accessibility settings" })
      }
    }

    if (pathname === "/api/v1/sessions/launch" && method === "POST") {
      try {
        const { browserName } = JSON.parse(await readTextBody(request)) as { browserName?: string }
        const browser = browserName ? browsers.find((b) => b.name === browserName) : browsers[0]
        if (!browser) return jsonResponse(404, { error: "No browser found" })
        execFileSync("open", ["-a", browser.appPath, "--args", "--remote-debugging-port=0"], {
          timeout: 5000,
          env: sanitizeEnvForBrowser(process.env),
        })
        await new Promise((r) => setTimeout(r, 1000))
        return jsonResponse(200, { ok: true, sessions: refreshSessions(browsers) })
      } catch (e: any) {
        return jsonResponse(500, { error: e.message || "Failed to launch browser" })
      }
    }

    const iconMatch = pathname.match(/^\/api\/v1\/browser-icon\/(.+)$/)
    if (iconMatch && method === "GET") {
      const icon = getBrowserIcon(decodeURIComponent(iconMatch[1]!))
      if (!icon) return new Response(null, { status: 404 })
      return new Response(new Uint8Array(icon), {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400",
        },
      })
    }

    if (pathname === "/api/v1/jobs" && method === "GET") {
      return jsonResponse(200, { jobs: await getJobsInfo(db) })
    }

    if (pathname === "/api/v1/jobs/runs" && method === "GET") {
      const offset = parseInt(parsedUrl.searchParams.get("offset") ?? "0", 10)
      const limit = parseInt(parsedUrl.searchParams.get("limit") ?? "50", 10)
      const runId = parsedUrl.searchParams.get("runId") || undefined
      const dateFrom = parsedUrl.searchParams.get("dateFrom") || undefined
      return jsonResponse(200, await getJobRuns(db, undefined, offset, limit, runId, dateFrom))
    }

    const jobRunsMatch = pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/runs$/)
    if (jobRunsMatch && method === "GET") {
      const jobId = decodeURIComponent(jobRunsMatch[1]!)
      const offset = parseInt(parsedUrl.searchParams.get("offset") ?? "0", 10)
      const limit = parseInt(parsedUrl.searchParams.get("limit") ?? "50", 10)
      return jsonResponse(200, await getJobRuns(db, jobId, offset, limit))
    }

    const jobRunMatch = pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/run$/)
    if (jobRunMatch && method === "POST") {
      const jobId = decodeURIComponent(jobRunMatch[1]!)
      let params: Record<string, unknown> | undefined
      try {
        const body = await readTextBody(request)
        if (body.trim()) params = JSON.parse(body) as Record<string, unknown>
      } catch (e: any) {
        return jsonResponse(400, { error: e.message || "Invalid request body" })
      }
      const result = triggerManualRun(jobId, params)
      return jsonResponse(result.ok ? 200 : 404, result)
    }

    const jobConfigMatch = pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/config$/)
    if (jobConfigMatch && method === "PUT") {
      const jobId = decodeURIComponent(jobConfigMatch[1]!)
      try {
        const config = JSON.parse(await readTextBody(request)) as Record<string, unknown>
        const ok = saveJobConfig(jobId, config)
        return jsonResponse(ok ? 200 : 404, ok ? { ok: true } : { error: `Job "${jobId}" not found` })
      } catch (e: any) {
        return jsonResponse(400, { error: e.message || "Invalid request body" })
      }
    }

    if (pathname === "/api/v1/x/check-tweets" && method === "POST") {
      try {
        const { urls } = JSON.parse(await readTextBody(request)) as { urls?: string }
        if (!urls || typeof urls !== "string") return jsonResponse(400, { error: "Missing 'urls' string field" })
        const tweetIds = parseTweetIds(urls)
        if (tweetIds.length === 0) return jsonResponse(200, { found: [], missing: [] })
        const docIds = tweetIds.map((id) => `x:${id}`)
        const result = await db.execute({
          sql: `SELECT id FROM documents WHERE id IN (${docIds.map(() => "?").join(", ")})`,
          args: docIds,
        })
        const foundDocIds = new Set(result.rows.map((r) => String(r.id)))
        const found: string[] = []
        const missing: string[] = []
        for (const id of tweetIds) {
          if (foundDocIds.has(`x:${id}`)) found.push(id)
          else missing.push(id)
        }
        return jsonResponse(200, { found, missing })
      } catch (e: any) {
        return jsonResponse(400, { error: e.message || "Invalid request body" })
      }
    }

    if (pathname === "/api/v1/x/open-tweets" && method === "POST") {
      try {
        const { tweetIds } = JSON.parse(await readTextBody(request)) as { tweetIds?: string[] }
        if (!tweetIds || !Array.isArray(tweetIds)) return jsonResponse(400, { error: "Missing 'tweetIds' array field" })
        if (tweetIds.length === 0) return jsonResponse(200, { ok: true, opened: 0 })
        const attached = refreshSessions(browsers).find((s) => s.attached)
        if (!attached) return jsonResponse(400, { error: "No browser connected" })
        const cdpSession = getSession(attached.sessionName)
        if (!cdpSession) return jsonResponse(400, { error: "CDP session not available" })
        let opened = 0
        for (const id of tweetIds) {
          try {
            await sendCommand(cdpSession.conn, "Target.createTarget", { url: `https://x.com/i/status/${id}` })
            opened++
          } catch (e: any) {
            log.warn(`Failed to open tab for tweet ${id}: ${e.message}`)
          }
        }
        return jsonResponse(200, { ok: true, opened })
      } catch (e: any) {
        return jsonResponse(400, { error: e.message || "Invalid request body" })
      }
    }

    if (pathname === "/api/v1/arxiv/check-papers" && method === "POST") {
      try {
        const { urls } = JSON.parse(await readTextBody(request)) as { urls?: string }
        if (!urls || typeof urls !== "string") return jsonResponse(400, { error: "Missing 'urls' string field" })
        const arxivIds = parseArxivIds(urls)
        if (arxivIds.length === 0) return jsonResponse(200, { found: [], missing: [] })
        const docIds = arxivIds.map((id) => `arxiv:${id}`)
        const result = await db.execute({
          sql: `SELECT id FROM documents WHERE id IN (${docIds.map(() => "?").join(", ")})`,
          args: docIds,
        })
        const foundDocIds = new Set(result.rows.map((r) => String(r.id)))
        const found: string[] = []
        const missing: string[] = []
        for (const id of arxivIds) {
          if (foundDocIds.has(`arxiv:${id}`)) found.push(id)
          else missing.push(id)
        }
        return jsonResponse(200, { found, missing })
      } catch (e: any) {
        return jsonResponse(400, { error: e.message || "Invalid request body" })
      }
    }

    if (pathname === "/api/v1/arxiv/open-papers" && method === "POST") {
      try {
        const { arxivIds } = JSON.parse(await readTextBody(request)) as { arxivIds?: string[] }
        if (!arxivIds || !Array.isArray(arxivIds)) return jsonResponse(400, { error: "Missing 'arxivIds' array field" })
        if (arxivIds.length === 0) return jsonResponse(200, { ok: true, opened: 0 })
        const attached = refreshSessions(browsers).find((s) => s.attached)
        if (!attached) return jsonResponse(400, { error: "No browser connected" })
        const cdpSession = getSession(attached.sessionName)
        if (!cdpSession) return jsonResponse(400, { error: "CDP session not available" })
        let opened = 0
        for (const id of arxivIds) {
          try {
            await sendCommand(cdpSession.conn, "Target.createTarget", { url: `https://arxiv.org/abs/${id}` })
            opened++
          } catch (e: any) {
            log.warn(`Failed to open tab for arxiv paper ${id}: ${e.message}`)
          }
        }
        return jsonResponse(200, { ok: true, opened })
      } catch (e: any) {
        return jsonResponse(400, { error: e.message || "Invalid request body" })
      }
    }

    if (pathname === "/api/v1/collectors" && method === "GET") {
      return jsonResponse(200, {
        collectors: collectors.map((c) => ({
          id: c.id,
          description: c.description,
          urlPatterns: c.urlPatterns,
          config: loadCollectorConfig(c.id),
        })),
      })
    }

    const collectorConfigMatch = pathname.match(/^\/api\/v1\/collectors\/([^/]+)\/config$/)
    if (collectorConfigMatch && method === "PUT") {
      const collectorId = collectorConfigMatch[1]!
      const known = collectors.find((c) => c.id === collectorId)
      if (!known) return jsonResponse(404, { error: `Collector '${collectorId}' not found` })
      try {
        const update = JSON.parse(await readTextBody(request)) as Record<string, unknown>
        if (update.enabled !== undefined && typeof update.enabled !== "boolean") return jsonResponse(400, { error: "enabled must be a boolean" })
        if (update.freshMinutes !== undefined && typeof update.freshMinutes !== "number") return jsonResponse(400, { error: "freshMinutes must be a number" })
        if (update.freshUnit !== undefined && update.freshUnit !== "sec" && update.freshUnit !== "min") return jsonResponse(400, { error: "freshUnit must be 'sec' or 'min'" })
        if (update.auto_detect !== undefined && (typeof update.auto_detect !== "object" || Array.isArray(update.auto_detect))) return jsonResponse(400, { error: "auto_detect must be an object" })
        const validLogLevels = new Set(["trace", "debug", "info", "warn", "error", "fatal"])
        if (update.logLevel !== undefined && (typeof update.logLevel !== "string" || !validLogLevels.has(update.logLevel as string))) {
          return jsonResponse(400, { error: "logLevel must be one of: trace, debug, info, warn, error, fatal" })
        }
        const allowedKeys = new Set(["enabled", "freshMinutes", "freshUnit", "auto_detect", "logLevel"])
        const unknownKeys = Object.keys(update).filter((k) => !allowedKeys.has(k))
        if (unknownKeys.length > 0) return jsonResponse(400, { error: `Unknown config keys: ${unknownKeys.join(", ")}` })
        const config = update as CollectorSettings
        saveCollectorConfig(collectorId, config)
        return jsonResponse(200, config)
      } catch (e: any) {
        return jsonResponse(400, { error: e.message || "Invalid request body" })
      }
    }

    if (pathname === "/api/v1/apps" && method === "GET") {
      const apps = loadApps()
      return jsonResponse(200, {
        apps: apps.map((a) => ({
          name: a.name,
          route: a.route,
          version: a.version,
          description: a.description,
          type: a.type,
          framework: a.framework,
          cdpHandlers: a.cdpHandlers,
          pageHandlers: a.pageHandlers,
          webHandlers: a.webHandlers,
        })),
      })
    }

    const appsRouteMatch = pathname.match(/^\/api\/v1\/apps\/([^/]+)\/(.+)$/)
    if (appsRouteMatch) {
      const [, appName, action] = appsRouteMatch
      if (action === "errors" && method === "GET") return jsonResponse(200, { errors: getAppErrors(appName!) })
      if (action === "errors" && method === "DELETE") {
        clearAppErrors(appName!)
        return jsonResponse(200, { ok: true })
      }
      if (action === "clear" && method === "GET") return jsonResponse(200, { flag: getClearFlag(appName!) })
      if (action === "clear" && method === "POST") {
        const ts = setClearFlag(appName!)
        return jsonResponse(200, { ok: true, timestamp: ts })
      }
      return jsonResponse(404, { error: "Not found" })
    }

    if (pathname === "/api/v1/apps/errors" && method === "GET") {
      return jsonResponse(200, { errors: getAllAppErrors() })
    }

    if (pathname === "/api/v1/gui/open-app" && method === "POST") {
      try {
        const data = JSON.parse(await readTextBody(request)) as { route: string; label?: string; params?: Record<string, unknown> }
        if (!data.route) return jsonResponse(400, { error: "route is required" })
        emitBackendEvent("open-app", data)
        return jsonResponse(200, { ok: true })
      } catch (e: any) {
        return jsonResponse(400, { error: e.message || "Invalid request body" })
      }
    }

    if (pathname === "/api/v1/articles" && method === "GET") {
      try {
        const offset = parseInt(parsedUrl.searchParams.get("offset") || "0", 10)
        const limit = parseInt(parsedUrl.searchParams.get("limit") || "50", 10)
        const q = parsedUrl.searchParams.get("q") || undefined
        const author = parsedUrl.searchParams.get("author") || undefined
        const dateFrom = parsedUrl.searchParams.get("dateFrom") || undefined
        const dateTo = parsedUrl.searchParams.get("dateTo") || undefined
        const articles = await listArticles({ offset, limit, q, author, dateFrom, dateTo })
        return jsonResponse(200, { articles, total: articles.length })
      } catch (e: any) {
        log.error({ err: e.message }, "Failed to list articles")
        return jsonResponse(500, { error: "Internal server error" })
      }
    }

    const articleVersionsMatch = pathname.match(/^\/api\/v1\/articles\/([^/]+)\/versions$/)
    if (articleVersionsMatch && method === "GET") {
      try {
        const sourceKey = decodeURIComponent(articleVersionsMatch[1]!)
        return jsonResponse(200, { versions: await getArticleVersions(sourceKey) })
      } catch (e: any) {
        log.error({ err: e.message }, "Failed to get article versions")
        return jsonResponse(500, { error: "Internal server error" })
      }
    }

    const articleImageMatch = pathname.match(/^\/api\/v1\/articles\/([^/]+)\/image\/(\d+)$/)
    if (articleImageMatch && method === "GET") {
      try {
        const articleId = decodeURIComponent(articleImageMatch[1]!)
        const index = parseInt(articleImageMatch[2]!, 10)
        const image = await getArticleImage(articleId, index)
        if (!image) return jsonResponse(404, { error: "Image not found" })
        let contentType = "application/octet-stream"
        try {
          const meta = JSON.parse(image.metadata) as { contentType?: string; mimeType?: string }
          contentType = meta.contentType || meta.mimeType || contentType
        } catch { /* use default */ }
        return new Response(new Uint8Array(image.data), { status: 200, headers: { "Content-Type": contentType } })
      } catch (e: any) {
        log.error({ err: e.message }, "Failed to get article image")
        return jsonResponse(500, { error: "Internal server error" })
      }
    }

    const articleMatch = pathname.match(/^\/api\/v1\/articles\/([^/]+)$/)
    if (articleMatch && method === "GET") {
      try {
        const article = await getArticle(decodeURIComponent(articleMatch[1]!))
        if (!article) return jsonResponse(404, { error: "Article not found" })
        return jsonResponse(200, { article })
      } catch (e: any) {
        log.error({ err: e.message }, "Failed to get article")
        return jsonResponse(500, { error: "Internal server error" })
      }
    }

    const appStaticMatch = pathname.match(/^\/app\/([^/]+)(.*)$/)
    if (appStaticMatch && method === "GET") {
      const [, appRoute, filePath] = appStaticMatch
      const apps = loadApps()
      const app = apps.find((a) => a.route === appRoute)
      if (app && app.webHandlers.length > 0) {
        for (const webDir of app.webHandlers) {
          const webDirPath = join(app.dirPath, webDir)
          const requestedFile = (filePath || "/").replace(/^\/+/, "") || "index.html"
          const fullPath = resolve(webDirPath, requestedFile)
          const resolvedBase = resolve(webDirPath)
          if (!fullPath.startsWith(resolvedBase + sep) && fullPath !== resolvedBase) continue
          const response = fileResponse(fullPath)
          if (response) return response
        }
      }
      return jsonResponse(404, { error: "Not found" })
    }

    const vizApiMatch = pathname.match(/^\/api\/v1\/([^/]+)(.*)$/)
    if (vizApiMatch) {
      const [, vizId, subPath] = vizApiMatch
      const viz = vizMap.get(vizId!)
      if (viz) {
        try {
          return await viz.handleApi(subPath || "/", parsedUrl.searchParams, request, db)
        } catch (e: any) {
          log.error({ err: e.message, vizId }, "Visualizer API error")
          return jsonResponse(500, { error: "Internal server error" })
        }
      }
      return jsonResponse(404, { error: "Not found" })
    }

    if (staticDir && method === "GET") {
      const staticResponse = staticFileResponse(staticDir, pathname)
      if (staticResponse) return staticResponse
    }

    if (staticDir && method === "GET" && !pathname.startsWith("/api/")) {
      const indexResponse = fileResponse(join(staticDir, "index.html"))
      if (indexResponse) return indexResponse
    }

    return jsonResponse(404, { error: "Not found" })
  }

  return {
    async handleRequest(request: ApiRequest): Promise<Response> {
      return withCors(request, await route(request))
    },
    close(): void {
      cleanupJobStarted()
      cleanupJobCompleted()
      setOnCdpEvent(() => {})
    },
  }
}
