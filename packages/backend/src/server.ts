/**
 * HTTP server.
 *
 * Routes:
 * - GET /health
 * - GET /api/v1/status
 * - GET /api/v1/settings
 * - PUT /api/v1/settings
 * - GET /api/v1/events                → SSE event stream
 * - GET /api/v1/apps                  → list discovered apps
 * - GET /api/v1/apps/:name/errors     → app error log
 * - DELETE /api/v1/apps/:name/errors  → clear app errors
 * - GET /api/v1/apps/:name/clear      → get clear flag
 * - POST /api/v1/apps/:name/clear     → set clear flag
 * - GET /api/v1/apps/errors           → all app errors
 * - POST /api/v1/gui/open-app         → open app tab via SSE
 * - GET /api/v1/articles              → list articles from SQLite
 * - GET /api/v1/articles/:id          → get single article
 * - GET /api/v1/articles/:id/image/:index → get article image blob
 * - GET /app/<route>/...              → web handler static files
 * - /api/v1/<visualizer_id>/... → visualizer.handleApi
 * - Static file serving (production)
 * - SPA fallback
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http"
import { execSync } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { join, resolve, extname, sep } from "node:path"
import { fileURLToPath } from "node:url"
import type { Client } from "@libsql/client"
import { type AppConfig } from "./config.js"
import { loadSettings, saveSettings, getBrowserIcon, type AppSettings, type BrowserEntry } from "./settings.js"
import { loadCollectorConfig, saveCollectorConfig, type CollectorSettings } from "./collector-config.js"
import { refreshSessions } from "./browser-monitor.js"
import { requestManualAttach, requestManualDetach } from "./attach-queue.js"
import { startCollectorRunner, stopCollectorRunner, type CollectorDefinition } from "./collector-runner.js"
import { loadApps } from "./apps.js"
import { getAppErrors, clearAppErrors, getAllAppErrors, getClearFlag, setClearFlag, setOnCdpEvent } from "./app-runner.js"
import { getJobsInfo, getJobRuns, triggerManualRun, saveJobConfig, onJobEvent } from "./job-runner.js"
import { getSession, sendCommand } from "./cdp.js"
import { parseTweetIds } from "./utils/parse-tweet-ids.js"
import { parseArxivIds } from "./utils/parse-arxiv-ids.js"
import { setArticleDb, listArticles, getArticle, getArticleVersions, getArticleImage } from "./storage/article-db.js"
import { createLogger } from "./logger.js"

const log = createLogger("server")

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

export interface VisualizerDefinition {
  id: string
  label: string
  initVisualizer?: (db: Client) => Promise<void>
  handleApi: (path: string, query: URLSearchParams, req: IncomingMessage, res: ServerResponse, db: Client) => void
}

export interface ServerConfig {
  appConfig: AppConfig
  staticDir?: string
  db: Client
  visualizers: VisualizerDefinition[]
  browsers: BrowserEntry[]
  collectors: CollectorDefinition[]
  /** Called after settings are saved via PUT /api/v1/settings. */
  onSettingsChanged?: (prev: AppSettings, next: AppSettings) => void
}

export interface ServerHandle {
  server: Server
  close(): void
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
}

function serveStatic(staticDir: string, url: string, res: ServerResponse): boolean {
  const pathname = url.split("?")[0]!
  const filePath = resolve(staticDir, "." + pathname)
  const resolvedBase = resolve(staticDir)
  if (!filePath.startsWith(resolvedBase + sep) && filePath !== resolvedBase) {
    return false
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) return false

  try {
    const content = readFileSync(filePath)
    const ext = extname(filePath)
    const mime = MIME_TYPES[ext] ?? "application/octet-stream"
    res.writeHead(200, { "Content-Type": mime })
    res.end(content)
    return true
  } catch {
    return false
  }
}

function setCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin
  // Only allow requests from localhost origins
  if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin)
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(data))
}

function documentIdRange(prefix: string): [string, string] {
  return [`${prefix}:`, `${prefix};`]
}

const MAX_BODY_BYTES = 1024 * 1024 // 1 MB

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

// ---------------------------------------------------------------------------
// SSE (Server-Sent Events) — broadcasts CDP events and GUI commands to clients
// ---------------------------------------------------------------------------

const sseClients = new Set<ServerResponse>()

export function broadcastSseEvent(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const client of sseClients) {
    try {
      client.write(payload)
    } catch {
      sseClients.delete(client)
    }
  }
}

/**
 * Kill any process currently listening on the given port.
 * Prevents EADDRINUSE from stale backend processes that survived Ctrl+C.
 */
function killStaleProcess(port: number): void {
  try {
    const pids = execSync(`lsof -ti:${port} 2>/dev/null`, { encoding: "utf-8" }).trim()
    if (!pids) return
    for (const pid of pids.split("\n")) {
      const n = parseInt(pid, 10)
      if (!n || n === process.pid) continue
      log.info({ pid: n, port }, "Killing stale process on port")
      try { process.kill(n, "SIGKILL") } catch { /* already dead */ }
    }
  } catch { /* lsof not found or no matches — fine */ }
}

export async function startServer(config: ServerConfig): Promise<ServerHandle> {
  const { appConfig, staticDir, db, visualizers, browsers, collectors, onSettingsChanged } = config
  const { host, port } = appConfig.server

  killStaleProcess(port)

  // Initialize article database (SQLite — shares the existing db client)
  setArticleDb(db)

  // Build visualizer route map: /api/v1/<id> → visualizer
  const vizMap = new Map<string, VisualizerDefinition>()
  for (const viz of visualizers) {
    vizMap.set(viz.id, viz)
  }

  const server = createServer(async (req, res) => {
    const url = req.url || "/"
    const method = (req.method || "GET").toUpperCase()
    const parsedUrl = new URL(url, `http://${host}:${port}`)
    const pathname = parsedUrl.pathname

    setCors(req, res)

    if (method === "OPTIONS") {
      res.writeHead(204)
      res.end()
      return
    }

    // Health check
    if (pathname === "/health") {
      sendJson(res, 200, { status: "ok" })
      return
    }

    // Status
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

      sendJson(res, 200, {
        version: VERSION,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        visualizers: visualizers.map((v) => ({ id: v.id, label: v.label })),
        totalDocuments,
        lastCollectionTime,
        collectors: collectorStats,
      })
      return
    }

    // Settings
    if (pathname === "/api/v1/settings") {
      if (method === "GET") {
        const settings = loadSettings()
        sendJson(res, 200, settings)
        return
      }
      if (method === "PUT") {
        try {
          const body = await readBody(req)
          const update = JSON.parse(body) as Record<string, unknown>
          // Validate known fields to prevent config corruption
          if (update.autoAttach !== undefined && typeof update.autoAttach !== "boolean") {
            sendJson(res, 400, { error: "autoAttach must be a boolean" })
            return
          }
          if (update.browsers !== undefined && !Array.isArray(update.browsers)) {
            sendJson(res, 400, { error: "browsers must be an array" })
            return
          }
          if (update.remoteDebuggingAutoAllow !== undefined && typeof update.remoteDebuggingAutoAllow !== "boolean") {
            sendJson(res, 400, { error: "remoteDebuggingAutoAllow must be a boolean" })
            return
          }
          if (update.logLevel !== undefined && typeof update.logLevel !== "string") {
            sendJson(res, 400, { error: "logLevel must be a string" })
            return
          }
          const allowedKeys = new Set(["autoAttach", "browsers", "server", "remoteDebuggingAutoAllow", "logLevel", "collectors"])
          const unknownKeys = Object.keys(update).filter((k) => !allowedKeys.has(k))
          if (unknownKeys.length > 0) {
            sendJson(res, 400, { error: `Unknown settings keys: ${unknownKeys.join(", ")}` })
            return
          }
          // Route collector settings to per-collector config files
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
          broadcastSseEvent("settings-changed", {})
          sendJson(res, 200, merged)
        } catch (e: any) {
          sendJson(res, 400, { error: e.message || "Invalid request body" })
        }
        return
      }
    }

    // Session management API
    if (pathname === "/api/v1/sessions" && method === "GET") {
      const sessions = refreshSessions(browsers)
      sendJson(res, 200, { sessions })
      return
    }

    if (pathname === "/api/v1/sessions/attach" && method === "POST") {
      try {
        const body = await readBody(req)
        const { sessionName } = JSON.parse(body) as { sessionName: string }
        if (!sessionName) {
          sendJson(res, 400, { error: "sessionName is required" })
          return
        }
        const sessions = refreshSessions(browsers)
        const session = sessions.find((s) => s.sessionName === sessionName)
        if (!session) {
          sendJson(res, 404, { error: "Session not found" })
          return
        }
        if (!session.cdpWsUrl) {
          sendJson(res, 400, { error: "No CDP endpoint available for this session" })
          return
        }
        const ok = await requestManualAttach(sessionName, session.cdpWsUrl)
        if (ok) {
          sendJson(res, 200, { ok: true, sessionName })
        } else {
          sendJson(res, 500, {
            ok: false,
            sessionName,
            error: `Could not connect to ${sessionName}. Remote debugging may not be enabled — check chrome://inspect or relaunch the browser with remote debugging allowed.`,
          })
        }
      } catch (e: any) {
        sendJson(res, 400, { error: e.message || "Invalid request body" })
      }
      return
    }

    if (pathname === "/api/v1/sessions/detach" && method === "POST") {
      try {
        const body = await readBody(req)
        const { sessionName } = JSON.parse(body) as { sessionName: string }
        if (!sessionName) {
          sendJson(res, 400, { error: "sessionName is required" })
          return
        }
        requestManualDetach(sessionName)
        sendJson(res, 200, { ok: true, sessionName })
      } catch (e: any) {
        sendJson(res, 400, { error: e.message || "Invalid request body" })
      }
      return
    }

    if (pathname === "/api/v1/open-accessibility-settings" && method === "POST") {
      try {
        const { execFileSync } = await import("node:child_process")
        execFileSync("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"], {
          timeout: 5000,
        })
        sendJson(res, 200, { ok: true })
      } catch (e: any) {
        sendJson(res, 500, { error: e.message || "Failed to open Accessibility settings" })
      }
      return
    }

    if (pathname === "/api/v1/sessions/launch" && method === "POST") {
      try {
        const { execFileSync } = await import("node:child_process")
        const body = await readBody(req)
        const { browserName } = JSON.parse(body) as { browserName?: string }
        const browser = browserName
          ? browsers.find((b) => b.name === browserName)
          : browsers[0]
        if (!browser) {
          sendJson(res, 404, { error: "No browser found" })
          return
        }
        // Launch Chrome with remote debugging enabled — use execFileSync to avoid shell injection
        execFileSync("open", ["-a", browser.appPath, "--args", "--remote-debugging-port=0"], {
          timeout: 5000,
          env: sanitizeEnvForBrowser(process.env),
        })
        // Wait briefly for process to start, then refresh
        await new Promise((r) => setTimeout(r, 1000))
        const sessions = refreshSessions(browsers)
        sendJson(res, 200, { ok: true, sessions })
      } catch (e: any) {
        sendJson(res, 500, { error: e.message || "Failed to launch browser" })
      }
      return
    }

    // Browser icon
    const iconMatch = pathname.match(/^\/api\/v1\/browser-icon\/(.+)$/)
    if (iconMatch && method === "GET") {
      const appPath = decodeURIComponent(iconMatch[1]!)
      const icon = getBrowserIcon(appPath)
      if (icon) {
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400",
        })
        res.end(icon)
      } else {
        res.writeHead(404)
        res.end()
      }
      return
    }

    // SSE event stream
    if (pathname === "/api/v1/events" && method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": req.headers.origin || "*",
      })
      res.write("event: connected\ndata: {}\n\n")
      sseClients.add(res)
      req.on("close", () => sseClients.delete(res))
      return
    }

    // Jobs API
    if (pathname === "/api/v1/jobs" && method === "GET") {
      const jobs = await getJobsInfo(db)
      sendJson(res, 200, { jobs })
      return
    }

    // All job runs (no job filter). Optional runId param ensures a specific run is included.
    if (pathname === "/api/v1/jobs/runs" && method === "GET") {
      const offset = parseInt(parsedUrl.searchParams.get("offset") ?? "0", 10)
      const limit = parseInt(parsedUrl.searchParams.get("limit") ?? "50", 10)
      const runId = parsedUrl.searchParams.get("runId") || undefined
      const dateFrom = parsedUrl.searchParams.get("dateFrom") || undefined
      const result = await getJobRuns(db, undefined, offset, limit, runId, dateFrom)
      sendJson(res, 200, result)
      return
    }

    const jobRunsMatch = pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/runs$/)
    if (jobRunsMatch && method === "GET") {
      const jobId = decodeURIComponent(jobRunsMatch[1]!)
      const offset = parseInt(parsedUrl.searchParams.get("offset") ?? "0", 10)
      const limit = parseInt(parsedUrl.searchParams.get("limit") ?? "50", 10)
      const result = await getJobRuns(db, jobId, offset, limit)
      sendJson(res, 200, result)
      return
    }

    const jobRunMatch = pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/run$/)
    if (jobRunMatch && method === "POST") {
      const jobId = decodeURIComponent(jobRunMatch[1]!)
      let params: Record<string, unknown> | undefined
      try {
        const body = await readBody(req)
        if (body.trim()) {
          params = JSON.parse(body) as Record<string, unknown>
        }
      } catch (e: any) {
        sendJson(res, 400, { error: e.message || "Invalid request body" })
        return
      }
      const result = triggerManualRun(jobId, params)
      sendJson(res, result.ok ? 200 : 404, result)
      return
    }

    // Job config PUT
    const jobConfigMatch = pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/config$/)
    if (jobConfigMatch && method === "PUT") {
      const jobId = decodeURIComponent(jobConfigMatch[1]!)
      try {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        const config = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>
        const ok = saveJobConfig(jobId, config)
        sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: `Job "${jobId}" not found` })
      } catch (e: any) {
        sendJson(res, 400, { error: e.message || "Invalid request body" })
      }
      return
    }

    // Check which tweet IDs exist in DB
    if (pathname === "/api/v1/x/check-tweets" && method === "POST") {
      try {
        const body = await readBody(req)
        const { urls } = JSON.parse(body) as { urls?: string }
        if (!urls || typeof urls !== "string") {
          sendJson(res, 400, { error: "Missing 'urls' string field" })
          return
        }
        const tweetIds = parseTweetIds(urls)
        if (tweetIds.length === 0) {
          sendJson(res, 200, { found: [], missing: [] })
          return
        }
        const docIds = tweetIds.map((id) => `x:${id}`)
        const placeholders = docIds.map(() => "?").join(", ")
        const result = await db.execute({
          sql: `SELECT id FROM documents WHERE id IN (${placeholders})`,
          args: docIds,
        })
        const foundDocIds = new Set(result.rows.map((r) => String(r.id)))
        const found: string[] = []
        const missing: string[] = []
        for (const id of tweetIds) {
          if (foundDocIds.has(`x:${id}`)) found.push(id)
          else missing.push(id)
        }
        sendJson(res, 200, { found, missing })
      } catch (e: any) {
        sendJson(res, 400, { error: e.message || "Invalid request body" })
      }
      return
    }

    // Open tweet pages via CDP
    if (pathname === "/api/v1/x/open-tweets" && method === "POST") {
      try {
        const body = await readBody(req)
        const { tweetIds } = JSON.parse(body) as { tweetIds?: string[] }
        if (!tweetIds || !Array.isArray(tweetIds)) {
          sendJson(res, 400, { error: "Missing 'tweetIds' array field" })
          return
        }
        if (tweetIds.length === 0) {
          sendJson(res, 200, { ok: true, opened: 0 })
          return
        }
        // Find an attached CDP session
        const allSessions = refreshSessions(browsers)
        const attached = allSessions.find((s) => s.attached)
        if (!attached) {
          sendJson(res, 400, { error: "No browser connected" })
          return
        }
        const cdpSession = getSession(attached.sessionName)
        if (!cdpSession) {
          sendJson(res, 400, { error: "CDP session not available" })
          return
        }
        let opened = 0
        for (const id of tweetIds) {
          try {
            await sendCommand(cdpSession.conn, "Target.createTarget", {
              url: `https://x.com/i/status/${id}`,
            })
            opened++
          } catch (e: any) {
            log.warn(`Failed to open tab for tweet ${id}: ${e.message}`)
          }
        }
        sendJson(res, 200, { ok: true, opened })
      } catch (e: any) {
        sendJson(res, 400, { error: e.message || "Invalid request body" })
      }
      return
    }

    // Check which arxiv paper IDs exist in DB
    if (pathname === "/api/v1/arxiv/check-papers" && method === "POST") {
      try {
        const body = await readBody(req)
        const { urls } = JSON.parse(body) as { urls?: string }
        if (!urls || typeof urls !== "string") {
          sendJson(res, 400, { error: "Missing 'urls' string field" })
          return
        }
        const arxivIds = parseArxivIds(urls)
        if (arxivIds.length === 0) {
          sendJson(res, 200, { found: [], missing: [] })
          return
        }
        const docIds = arxivIds.map((id) => `arxiv:${id}`)
        const placeholders = docIds.map(() => "?").join(", ")
        const result = await db.execute({
          sql: `SELECT id FROM documents WHERE id IN (${placeholders})`,
          args: docIds,
        })
        const foundDocIds = new Set(result.rows.map((r) => String(r.id)))
        const found: string[] = []
        const missing: string[] = []
        for (const id of arxivIds) {
          if (foundDocIds.has(`arxiv:${id}`)) found.push(id)
          else missing.push(id)
        }
        sendJson(res, 200, { found, missing })
      } catch (e: any) {
        sendJson(res, 400, { error: e.message || "Invalid request body" })
      }
      return
    }

    // Open arxiv pages via CDP for collection
    if (pathname === "/api/v1/arxiv/open-papers" && method === "POST") {
      try {
        const body = await readBody(req)
        const { arxivIds } = JSON.parse(body) as { arxivIds?: string[] }
        if (!arxivIds || !Array.isArray(arxivIds)) {
          sendJson(res, 400, { error: "Missing 'arxivIds' array field" })
          return
        }
        if (arxivIds.length === 0) {
          sendJson(res, 200, { ok: true, opened: 0 })
          return
        }
        const allSessions = refreshSessions(browsers)
        const attached = allSessions.find((s) => s.attached)
        if (!attached) {
          sendJson(res, 400, { error: "No browser connected" })
          return
        }
        const cdpSession = getSession(attached.sessionName)
        if (!cdpSession) {
          sendJson(res, 400, { error: "CDP session not available" })
          return
        }
        let opened = 0
        for (const id of arxivIds) {
          try {
            await sendCommand(cdpSession.conn, "Target.createTarget", {
              url: `https://arxiv.org/abs/${id}`,
            })
            opened++
          } catch (e: any) {
            log.warn(`Failed to open tab for arxiv paper ${id}: ${e.message}`)
          }
        }
        sendJson(res, 200, { ok: true, opened })
      } catch (e: any) {
        sendJson(res, 400, { error: e.message || "Invalid request body" })
      }
      return
    }

    // Collectors list
    if (pathname === "/api/v1/collectors" && method === "GET") {
      sendJson(res, 200, {
        collectors: collectors.map((c) => ({
          id: c.id,
          description: c.description,
          urlPatterns: c.urlPatterns,
          config: loadCollectorConfig(c.id),
        })),
      })
      return
    }

    // Per-collector config update — eliminates read-modify-write race through AppSettings
    const collectorConfigMatch = pathname.match(/^\/api\/v1\/collectors\/([^/]+)\/config$/)
    if (collectorConfigMatch && method === "PUT") {
      const collectorId = collectorConfigMatch[1]!
      const known = collectors.find((c) => c.id === collectorId)
      if (!known) {
        sendJson(res, 404, { error: `Collector '${collectorId}' not found` })
        return
      }
      try {
        const body = await readBody(req)
        const update = JSON.parse(body) as Record<string, unknown>
        // Validate known CollectorSettings fields
        if (update.enabled !== undefined && typeof update.enabled !== "boolean") {
          sendJson(res, 400, { error: "enabled must be a boolean" })
          return
        }
        if (update.freshMinutes !== undefined && typeof update.freshMinutes !== "number") {
          sendJson(res, 400, { error: "freshMinutes must be a number" })
          return
        }
        if (update.freshUnit !== undefined && update.freshUnit !== "sec" && update.freshUnit !== "min") {
          sendJson(res, 400, { error: "freshUnit must be 'sec' or 'min'" })
          return
        }
        if (update.auto_detect !== undefined && (typeof update.auto_detect !== "object" || Array.isArray(update.auto_detect))) {
          sendJson(res, 400, { error: "auto_detect must be an object" })
          return
        }
        const validLogLevels = new Set(["trace", "debug", "info", "warn", "error", "fatal"])
        if (update.logLevel !== undefined && (typeof update.logLevel !== "string" || !validLogLevels.has(update.logLevel as string))) {
          sendJson(res, 400, { error: "logLevel must be one of: trace, debug, info, warn, error, fatal" })
          return
        }
        const allowedKeys = new Set(["enabled", "freshMinutes", "freshUnit", "auto_detect", "logLevel"])
        const unknownKeys = Object.keys(update).filter((k) => !allowedKeys.has(k))
        if (unknownKeys.length > 0) {
          sendJson(res, 400, { error: `Unknown config keys: ${unknownKeys.join(", ")}` })
          return
        }
        const config = update as CollectorSettings
        saveCollectorConfig(collectorId, config)
        sendJson(res, 200, config)
      } catch (e: any) {
        sendJson(res, 400, { error: e.message || "Invalid request body" })
      }
      return
    }

    // App API routes
    if (pathname === "/api/v1/apps" && method === "GET") {
      const apps = loadApps()
      sendJson(res, 200, {
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
      return
    }

    const appsRouteMatch = pathname.match(/^\/api\/v1\/apps\/([^/]+)\/(.+)$/)
    if (appsRouteMatch) {
      const [, appName, action] = appsRouteMatch
      if (action === "errors" && method === "GET") {
        sendJson(res, 200, { errors: getAppErrors(appName!) })
        return
      }
      if (action === "errors" && method === "DELETE") {
        clearAppErrors(appName!)
        sendJson(res, 200, { ok: true })
        return
      }
      if (action === "clear" && method === "GET") {
        sendJson(res, 200, { flag: getClearFlag(appName!) })
        return
      }
      if (action === "clear" && method === "POST") {
        const ts = setClearFlag(appName!)
        sendJson(res, 200, { ok: true, timestamp: ts })
        return
      }
      sendJson(res, 404, { error: "Not found" })
      return
    }

    if (pathname === "/api/v1/apps/errors" && method === "GET") {
      sendJson(res, 200, { errors: getAllAppErrors() })
      return
    }

    // POST /api/v1/gui/open-app — forward to SSE clients
    if (pathname === "/api/v1/gui/open-app" && method === "POST") {
      try {
        const body = await readBody(req)
        const data = JSON.parse(body) as { route: string; label?: string; params?: Record<string, unknown> }
        if (!data.route) {
          sendJson(res, 400, { error: "route is required" })
          return
        }
        // Broadcast to SSE clients (handled in Unit 2.5)
        broadcastSseEvent("open-app", data)
        sendJson(res, 200, { ok: true })
      } catch (e: any) {
        sendJson(res, 400, { error: e.message || "Invalid request body" })
      }
      return
    }

    // Articles API — list articles
    if (pathname === "/api/v1/articles" && method === "GET") {
      try {
        const offset = parseInt(parsedUrl.searchParams.get("offset") || "0", 10)
        const limit = parseInt(parsedUrl.searchParams.get("limit") || "50", 10)
        const q = parsedUrl.searchParams.get("q") || undefined
        const author = parsedUrl.searchParams.get("author") || undefined
        const dateFrom = parsedUrl.searchParams.get("dateFrom") || undefined
        const dateTo = parsedUrl.searchParams.get("dateTo") || undefined
        const articles = await listArticles({ offset, limit, q, author, dateFrom, dateTo })
        sendJson(res, 200, { articles, total: articles.length })
      } catch (e: any) {
        log.error({ err: e.message }, "Failed to list articles")
        sendJson(res, 500, { error: "Internal server error" })
      }
      return
    }

    // Articles API — get all versions of an article by source_key
    const articleVersionsMatch = pathname.match(/^\/api\/v1\/articles\/([^/]+)\/versions$/)
    if (articleVersionsMatch && method === "GET") {
      let sourceKey: string
      try {
        sourceKey = decodeURIComponent(articleVersionsMatch[1]!)
      } catch {
        sendJson(res, 400, { error: "Invalid URL encoding" })
        return
      }
      try {
        const versions = await getArticleVersions(sourceKey)
        sendJson(res, 200, { versions })
      } catch (e: any) {
        log.error({ err: e.message }, "Failed to get article versions")
        sendJson(res, 500, { error: "Internal server error" })
      }
      return
    }

    // Articles API — get article image (must be before the single-article match)
    const articleImageMatch = pathname.match(/^\/api\/v1\/articles\/([^/]+)\/image\/(\d+)$/)
    if (articleImageMatch && method === "GET") {
      try {
        const articleId = decodeURIComponent(articleImageMatch[1]!)
        const index = parseInt(articleImageMatch[2]!, 10)
        const image = await getArticleImage(articleId, index)
        if (!image) {
          sendJson(res, 404, { error: "Image not found" })
          return
        }
        // Parse metadata to get content type
        let contentType = "application/octet-stream"
        try {
          const meta = JSON.parse(image.metadata) as { contentType?: string; mimeType?: string }
          contentType = meta.contentType || meta.mimeType || contentType
        } catch { /* use default */ }
        res.writeHead(200, { "Content-Type": contentType })
        res.end(image.data)
      } catch (e: any) {
        log.error({ err: e.message }, "Failed to get article image")
        sendJson(res, 500, { error: "Internal server error" })
      }
      return
    }

    // Articles API — get single article
    const articleMatch = pathname.match(/^\/api\/v1\/articles\/([^/]+)$/)
    if (articleMatch && method === "GET") {
      try {
        const articleId = decodeURIComponent(articleMatch[1]!)
        const article = await getArticle(articleId)
        if (!article) {
          sendJson(res, 404, { error: "Article not found" })
          return
        }
        sendJson(res, 200, { article })
      } catch (e: any) {
        log.error({ err: e.message }, "Failed to get article")
        sendJson(res, 500, { error: "Internal server error" })
      }
      return
    }

    // Serve web handler static files: /app/<route>/...
    const appStaticMatch = pathname.match(/^\/app\/([^/]+)(.*)$/)
    if (appStaticMatch && method === "GET") {
      const [, appRoute, filePath] = appStaticMatch
      const apps = loadApps()
      const app = apps.find((a) => a.route === appRoute)
      if (app && app.webHandlers.length > 0) {
        // Try each web handler directory in order
        for (const webDir of app.webHandlers) {
          const webDirPath = join(app.dirPath, webDir)
          const requestedFile = (filePath || "/").replace(/^\/+/, "") || "index.html"
          const fullPath = resolve(webDirPath, requestedFile)
          // Security: ensure the resolved path is within the web handler directory
          const resolvedBase = resolve(webDirPath)
          if (!fullPath.startsWith(resolvedBase + sep) && fullPath !== resolvedBase) continue
          if (existsSync(fullPath) && statSync(fullPath).isFile()) {
            try {
              const content = readFileSync(fullPath)
              const ext = extname(fullPath)
              const mime = MIME_TYPES[ext] ?? "application/octet-stream"
              res.writeHead(200, { "Content-Type": mime })
              res.end(content)
              return
            } catch { continue }
          }
        }
      }
      sendJson(res, 404, { error: "Not found" })
      return
    }

    // Visualizer API routing: /api/v1/<id>/...
    const vizApiMatch = pathname.match(/^\/api\/v1\/([^/]+)(.*)$/)
    if (vizApiMatch) {
      const [, vizId, subPath] = vizApiMatch
      const viz = vizMap.get(vizId!)
      if (viz) {
        try {
          viz.handleApi(subPath || "/", parsedUrl.searchParams, req, res, db)
        } catch (e: any) {
          log.error({ err: e.message, vizId }, "Visualizer API error")
          sendJson(res, 500, { error: "Internal server error" })
        }
        return
      }
      // Unknown API path (status/settings already handled above via early return)
      sendJson(res, 404, { error: "Not found" })
      return
    }

    // Static file serving (production)
    if (staticDir && method === "GET") {
      if (serveStatic(staticDir, url, res)) return
    }

    // SPA fallback
    if (staticDir && method === "GET" && !pathname.startsWith("/api/")) {
      const indexPath = join(staticDir, "index.html")
      if (existsSync(indexPath)) {
        const content = readFileSync(indexPath)
        res.writeHead(200, { "Content-Type": "text/html" })
        res.end(content)
        return
      }
    }

    // 404
    sendJson(res, 404, { error: "Not found" })
  })

  // Wire up CDP event forwarding to SSE clients
  setOnCdpEvent((sessionName, method, params) => {
    broadcastSseEvent("cdp", { sessionName, method, params })
  })

  // Wire up job run start + completion to SSE clients
  onJobEvent("job:run-started", (payload) => {
    broadcastSseEvent("jobs-updated", payload)
  })
  onJobEvent("job:run-completed", (payload) => {
    broadcastSseEvent("jobs-updated", payload)
  })

  return new Promise((resolve, reject) => {
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        log.error({ port, host }, `Port ${port} is still in use after cleanup — another process grabbed it`)
      }
      reject(err)
    })
    server.listen(port, host, () => {
      log.info(`Server listening on http://${host}:${port}`)
      resolve({
        server,
        close() {
          // Clean up SSE clients on shutdown
          for (const client of sseClients) {
            try { client.end() } catch { /* ignore */ }
          }
          sseClients.clear()
          server.close()
        },
      })
    })
  })
}
