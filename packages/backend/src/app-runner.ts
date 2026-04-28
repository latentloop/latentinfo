/**
 * App runner — orchestrates app execution on matching browser pages.
 *
 * Uses raw CDP for all browser interaction:
 * - Target.setDiscoverTargets for detecting all pages (existing + new)
 * - Target.attachToTarget for per-page sessions
 * - Runtime.evaluate for page.evaluate()
 * - Page.captureScreenshot for page.screenshot()
 * - Runtime.addBinding for page.exposeFunction()
 */

import { createClient, type Client } from "@libsql/client"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { runInNewContext } from "node:vm"
import {
  getSession,
  sendCommand,
  onEvent,
  attachTarget,
  removeTarget,
  NOTIFY_BINDING_NAME,
  type CdpConnection,
  type PageTarget,
} from "./cdp.js"
import { loadApps, loadAppScript, type AppDefinition } from "./apps.js"
import { getProfileDir } from "./config.js"
import { loadSettings } from "./settings.js"
import { createLogger } from "./logger.js"
import { emitBackendEvent } from "./events.js"

const log = createLogger("runner")

function isStaleSessionError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  return e.message.includes("-32001") || e.message.includes("Session with given id not found")
}

// ---------------------------------------------------------------------------
// CDP event forwarding
// ---------------------------------------------------------------------------

type CdpEventCallback = (sessionName: string, method: string, params: Record<string, unknown>) => void
let _onCdpEvent: CdpEventCallback | null = null

export function setOnCdpEvent(cb: CdpEventCallback): void {
  _onCdpEvent = cb
}

// ---------------------------------------------------------------------------
// Notification handlers
// ---------------------------------------------------------------------------

const notifyHandlers = new Map<string, Array<(payload: string) => void>>()

function registerNotifyHandler(targetId: string, callback: (payload: string) => void): void {
  let handlers = notifyHandlers.get(targetId)
  if (!handlers) {
    handlers = []
    notifyHandlers.set(targetId, handlers)
  }
  handlers.push(callback)
}

function clearNotifyHandlers(targetId: string): void {
  notifyHandlers.delete(targetId)
}

function dispatchNotify(targetId: string, payload: string): void {
  const handlers = notifyHandlers.get(targetId)
  if (!handlers) return
  for (const handler of handlers) {
    try { handler(payload) } catch (e) {
      if (!isStaleSessionError(e)) log.error(e, "Notify handler error")
    }
  }
}

// ---------------------------------------------------------------------------
// PageProxy — clean API for app scripts, backed by raw CDP
// ---------------------------------------------------------------------------

function createPageProxy(conn: CdpConnection, target: PageTarget) {
  const sid = target.sessionId

  async function cdpEval(expression: string): Promise<unknown> {
    const result = await sendCommand(conn, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, sid) as { result: { value: unknown }; exceptionDetails?: unknown }

    if (result.exceptionDetails) {
      const details = result.exceptionDetails as Record<string, unknown>
      const exception = details.exception as Record<string, unknown> | undefined
      throw new Error(String(exception?.description ?? details.text ?? "Evaluation failed"))
    }

    return result.result.value
  }

  return {
    url: () => target.url,

    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    evaluate: async (fn: string | Function, arg?: unknown) => {
      let expression: string
      if (typeof fn === "function") {
        const argJson = arg !== undefined ? JSON.stringify(arg) : "undefined"
        expression = `(${fn.toString()})(${argJson})`
      } else {
        expression = fn
      }
      return cdpEval(expression)
    },

    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    installModule: async (name: string, moduleObj: Record<string, Function | string | number | boolean>) => {
      const entries: string[] = []
      for (const [key, val] of Object.entries(moduleObj)) {
        if (typeof val === "function") {
          entries.push(`${JSON.stringify(key)}: ${val.toString()}`)
        } else {
          entries.push(`${JSON.stringify(key)}: ${JSON.stringify(val)}`)
        }
      }
      const escaped = JSON.stringify(name)
      // Provide __name shim — esbuild/tsx injects __name(fn, "name") calls inside
      // serialized functions, but the browser page context doesn't have it.
      // Also expose each function as a window global so cross-function references work.
      const fnKeys = Object.entries(moduleObj)
        .filter(([, v]) => typeof v === "function")
        .map(([k]) => k)
      const globals = fnKeys.map((k) => `window.${k} = mod[${JSON.stringify(k)}];`).join("\n        ")
      await cdpEval(`(function() {
        if (typeof __name === "undefined") { window.__name = function(fn) { return fn; }; }
        window.__latent = window.__latent || {};
        var mod = { ${entries.join(", ")} };
        window.__latent[${escaped}] = mod;
        ${globals}
      })()`)
    },

    unloadModule: async (name: string) => {
      const escaped = JSON.stringify(name)
      await cdpEval(`(function() {
        if (window.__latent) delete window.__latent[${escaped}];
      })()`)
    },

    callModule: async (moduleName: string, fnName: string, arg?: unknown) => {
      const argJson = arg !== undefined ? JSON.stringify(arg) : ""
      return cdpEval(`window.__latent[${JSON.stringify(moduleName)}][${JSON.stringify(fnName)}](${argJson})`)
    },

    screenshot: async (options: Record<string, unknown> = {}) => {
      const formatOption = options.format ?? options.type
      const format = formatOption === "jpeg" || formatOption === "webp" ? formatOption : "png"
      const qualityRaw = typeof options.quality === "number" ? Math.round(options.quality) : null
      const quality = qualityRaw === null ? null : Math.max(1, Math.min(100, qualityRaw))
      const clipInput = options.clip as Record<string, unknown> | undefined
      const clip = clipInput && typeof clipInput.x === "number" && typeof clipInput.y === "number" &&
        typeof clipInput.width === "number" && typeof clipInput.height === "number"
        ? {
            x: clipInput.x, y: clipInput.y,
            width: clipInput.width, height: clipInput.height,
            scale: typeof clipInput.scale === "number" ? clipInput.scale : 1,
          }
        : undefined

      const params: Record<string, unknown> = {
        format,
        fromSurface: typeof options.fromSurface === "boolean" ? options.fromSurface : false,
        optimizeForSpeed: typeof options.optimizeForSpeed === "boolean" ? options.optimizeForSpeed : true,
        captureBeyondViewport: typeof options.captureBeyondViewport === "boolean"
          ? options.captureBeyondViewport : true,
      }
      if (quality !== null && format !== "png") params.quality = quality
      if (clip) params.clip = clip

      const result = await sendCommand(conn, "Page.captureScreenshot", params, sid) as { data: string }
      return Buffer.from(result.data, "base64")
    },

    isClosed: () => !getSession(conn.sessionName)?.targets.has(target.targetId),

    locator: (selector: string) => ({
      first: () => ({
        screenshot: async (options: Record<string, unknown> = {}) => {
          const proxy = createPageProxy(conn, target)
          const escaped = JSON.stringify(selector)
          const rect = await proxy.evaluate(`
            (function() {
              var el = document.querySelector(${escaped});
              if (!el) return null;
              var r = el.getBoundingClientRect();
              return { x: r.x, y: r.y, width: r.width, height: r.height };
            })()
          `) as { x: number; y: number; width: number; height: number } | null
          if (!rect) throw new Error(`Element not found: ${selector}`)
          return proxy.screenshot({ ...options, clip: rect })
        },
        isVisible: async () => {
          const proxy = createPageProxy(conn, target)
          const escaped = JSON.stringify(selector)
          return await proxy.evaluate(`
            (function() {
              var el = document.querySelector(${escaped});
              if (!el) return false;
              var r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
            })()
          `) as boolean
        },
      }),
    }),

    onNotify: (callback: (payload: string) => void) => {
      registerNotifyHandler(target.targetId, callback)
    },

    addInitScript: async (script: string): Promise<string> => {
      const result = await sendCommand(conn, "Page.addScriptToEvaluateOnNewDocument", {
        source: script,
      }, sid) as { identifier: string }
      return result.identifier
    },

    removeInitScript: async (identifier: string): Promise<void> => {
      await sendCommand(conn, "Page.removeScriptToEvaluateOnNewDocument", {
        identifier,
      }, sid)
    },

    _target: target,
  }
}

export type PageProxy = ReturnType<typeof createPageProxy>

// ---------------------------------------------------------------------------
// App module interface
// ---------------------------------------------------------------------------

interface AppModule {
  matcher: (page: PageProxy, lwe: LweContext, sessionApp: SessionApp, sessionPage: SessionPage) => boolean | Promise<boolean>
  run: (page: PageProxy, lwe: LweContext, sessionApp: SessionApp, sessionPage: SessionPage) => Promise<void>
}

interface CdpHandlerModule {
  run: (lwe: LweContext, sessionApp: SessionApp) => Promise<void>
}

export interface AppLog {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
}

export interface CdpAccess {
  onEvent(method: string, callback: (params: Record<string, unknown>, sessionId?: string) => void): void
  sendCommand(method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs?: number): Promise<unknown>
}

export interface LweContext {
  appName: string
  profileDir: string
  appDir: string
  logLevel: string
  log: AppLog
  createDb: (name: string) => Client
  raiseError: (message: string) => void
  cdp: CdpAccess | null
  openApp: (route: string, params?: Record<string, string | number>) => void
}

export type SessionApp = Record<string, unknown>

export interface SessionPage {
  uuid: string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Runner state
// ---------------------------------------------------------------------------

interface RunnerState {
  sessionName: string
  conn: CdpConnection
  appSessions: Map<string, SessionApp>
  injectedTargets: Map<string, Set<string>>
  cleanups: (() => void)[]
  active: boolean
  cdpReady: boolean
}

const runners = new Map<string, RunnerState>()

// ---------------------------------------------------------------------------
// LweContext factory
// ---------------------------------------------------------------------------

function createLweContext(appName: string, appDir: string): LweContext {
  const profileDir = getProfileDir()
  const openDbs = new Map<string, Client>()
  const appLog = createLogger(`app:${appName}`)

  const wrappedLog: AppLog = {
    info: (...args: unknown[]) => appLog.info(args.map(String).join(" ")),
    debug: (...args: unknown[]) => appLog.debug(args.map(String).join(" ")),
    warn: (...args: unknown[]) => {
      appLog.warn(args.map(String).join(" "))
      addAppError(appName, args.map(String).join(" "), "warning")
    },
    error: (...args: unknown[]) => {
      appLog.error(args.map(String).join(" "))
      addAppError(appName, args.map(String).join(" "), "error")
    },
  }

  const settings = loadSettings()

  return {
    appName,
    profileDir,
    appDir,
    logLevel: settings.logLevel ?? "warn",
    log: wrappedLog,
    cdp: null,
    createDb(name: string): Client {
      const existing = openDbs.get(name)
      if (existing) return existing
      const dbPath = join(appDir, `${name}.db`)
      const client = createClient({ url: `file:${dbPath}` })
      openDbs.set(name, client)
      return client
    },
    raiseError(message: string): void {
      addAppError(appName, message, "error")
    },
    openApp(route: string, params?: Record<string, string | number>): void {
      try {
        emitBackendEvent("open-app", { route, label: appName, params })
      } catch (e) {
        wrappedLog.debug("openApp error: " + String(e))
      }
    },
  }
}

// ---------------------------------------------------------------------------
// App error storage
// ---------------------------------------------------------------------------

export interface AppError {
  message: string
  timestamp: string
  level: "error" | "warning"
}

function getErrorsFilePath(): string {
  return join(getProfileDir(), "app-errors.json")
}

function readErrorsFile(): Record<string, AppError[]> {
  try {
    const filePath = getErrorsFilePath()
    if (existsSync(filePath)) {
      return JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, AppError[]>
    }
  } catch { /* start fresh */ }
  return {}
}

function writeErrorsFile(data: Record<string, AppError[]>): void {
  writeFileSync(getErrorsFilePath(), JSON.stringify(data, null, 2), "utf-8")
}

function addAppError(appName: string, message: string, level: "error" | "warning" = "error"): void {
  const data = readErrorsFile()
  if (!data[appName]) data[appName] = []
  data[appName].push({ message, timestamp: new Date().toISOString(), level })
  if (data[appName].length > 50) data[appName] = data[appName].slice(-50)
  writeErrorsFile(data)
  if (level === "error") {
    log.warn({ appName, message }, "App error raised")
  }
}

export function getAppErrors(appName: string): AppError[] {
  return readErrorsFile()[appName] ?? []
}

export function getAllAppErrors(): Record<string, AppError[]> {
  return readErrorsFile()
}

export function clearAppErrors(appName: string): void {
  const data = readErrorsFile()
  delete data[appName]
  writeErrorsFile(data)
}

// ---------------------------------------------------------------------------
// Clear flags
// ---------------------------------------------------------------------------

function getClearFlagsPath(): string {
  return join(getProfileDir(), "app-clear-flags.json")
}

function readClearFlags(): Record<string, string> {
  try {
    const filePath = getClearFlagsPath()
    if (existsSync(filePath)) {
      return JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, string>
    }
  } catch { /* start fresh */ }
  return {}
}

function writeClearFlags(data: Record<string, string>): void {
  writeFileSync(getClearFlagsPath(), JSON.stringify(data, null, 2), "utf-8")
}

export function getClearFlag(appName: string): string | null {
  return readClearFlags()[appName] ?? null
}

export function setClearFlag(appName: string): string {
  const flags = readClearFlags()
  const ts = new Date().toISOString()
  flags[appName] = ts
  writeClearFlags(flags)
  return ts
}

// ---------------------------------------------------------------------------
// Start / Stop
// ---------------------------------------------------------------------------

export async function startAppRunner(sessionName: string): Promise<boolean> {
  const session = getSession(sessionName)
  if (!session) {
    log.warn({ sessionName }, "Cannot start runner: no CDP session")
    return false
  }

  if (runners.has(sessionName)) {
    log.debug({ sessionName }, "Runner already active")
    return true
  }

  const conn = session.conn
  const state: RunnerState = {
    sessionName,
    conn,
    appSessions: new Map(),
    injectedTargets: new Map(),
    cleanups: [],
    active: true,
    cdpReady: false,
  }
  runners.set(sessionName, state)

  // Listen for CDP events and forward them
  const unsubTargetCreated = onEvent(conn, "Target.targetCreated", (params) => {
    if (!state.active) return
    const info = params.targetInfo as Record<string, unknown>
    if (info.type !== "page") return
    const targetId = String(info.targetId)
    const url = String(info.url || "")
    if (state.cdpReady) {
      handleNewTarget(state, targetId, url).catch((e) => {
        if (!isStaleSessionError(e)) log.error(e, "handleNewTarget error")
      })
    }
    _onCdpEvent?.(sessionName, "Target.targetCreated", params)
  })
  state.cleanups.push(unsubTargetCreated)

  const unsubTargetChanged = onEvent(conn, "Target.targetInfoChanged", (params) => {
    if (!state.active) return
    const info = params.targetInfo as Record<string, unknown>
    if (info.type !== "page") return
    const targetId = String(info.targetId)
    const url = String(info.url || "")
    // Update URL on existing target
    const session = getSession(sessionName)
    if (session) {
      const target = session.targets.get(targetId)
      if (target) target.url = url
    }
    _onCdpEvent?.(sessionName, "Target.targetInfoChanged", params)
  })
  state.cleanups.push(unsubTargetChanged)

  const unsubTargetDestroyed = onEvent(conn, "Target.targetDestroyed", (params) => {
    if (!state.active) return
    const targetId = String(params.targetId)
    state.injectedTargets.delete(targetId)
    clearNotifyHandlers(targetId)
    const session = getSession(sessionName)
    if (session) removeTarget(session, targetId)
    _onCdpEvent?.(sessionName, "Target.targetDestroyed", params)
  })
  state.cleanups.push(unsubTargetDestroyed)

  const unsubBinding = onEvent(conn, "Runtime.bindingCalled", (params, eventSessionId) => {
    if (!state.active) return
    if (params.name !== NOTIFY_BINDING_NAME) return
    // Find target by sessionId
    const session = getSession(sessionName)
    if (!session) return
    for (const [targetId, target] of session.targets) {
      if (target.sessionId === eventSessionId) {
        dispatchNotify(targetId, String(params.payload))
        break
      }
    }
  })
  state.cleanups.push(unsubBinding)

  const unsubFrameNav = onEvent(conn, "Page.frameNavigated", (params, eventSessionId) => {
    if (!state.active || !state.cdpReady) return
    const frame = params.frame as Record<string, unknown> | undefined
    if (!frame || frame.parentId) return // only top-level frames
    const url = String(frame.url || "")
    const session = getSession(sessionName)
    if (!session) return
    for (const [targetId, target] of session.targets) {
      if (target.sessionId === eventSessionId) {
        target.url = url
        // Re-check apps for this target after navigation
        checkAndRunApps(state, target).catch((e) => {
          if (!isStaleSessionError(e)) log.error(e, "checkAndRunApps after nav error")
        })
        break
      }
    }
    _onCdpEvent?.(sessionName, "Page.frameNavigated", params)
  })
  state.cleanups.push(unsubFrameNav)

  // Enable target discovery
  try {
    await sendCommand(conn, "Target.setDiscoverTargets", { discover: true })
  } catch (e) {
    log.error(e, "Failed to enable target discovery")
    stopAppRunner(sessionName)
    return false
  }

  // Run CDP handlers
  await runCdpHandlers(state)
  state.cdpReady = true

  // Attach to existing page targets
  try {
    const result = await sendCommand(conn, "Target.getTargets") as { targetInfos: Record<string, unknown>[] }
    const pageTargets = (result.targetInfos || []).filter((t) => t.type === "page")
    await Promise.all(
      pageTargets.map((t) =>
        handleNewTarget(state, String(t.targetId), String(t.url || "")).catch((e) => {
          if (!isStaleSessionError(e)) log.error(e, "Initial target attach error")
        })
      ),
    )
  } catch (e) {
    log.error(e, "Failed to get existing targets")
  }

  log.info({ sessionName }, "App runner started")
  return true
}

export function stopAppRunner(sessionName: string): void {
  const state = runners.get(sessionName)
  if (!state) return
  state.active = false
  for (const cleanup of state.cleanups) cleanup()
  state.cleanups.length = 0
  // Clear notify handlers for all known targets
  for (const targetId of state.injectedTargets.keys()) {
    clearNotifyHandlers(targetId)
  }
  runners.delete(sessionName)
  log.info({ sessionName }, "App runner stopped")
}

// ---------------------------------------------------------------------------
// Target handling
// ---------------------------------------------------------------------------

const processingTargets = new Set<string>()

async function handleNewTarget(state: RunnerState, targetId: string, url: string): Promise<void> {
  if (!state.active) return
  if (processingTargets.has(targetId)) return
  processingTargets.add(targetId)

  try {
    const session = getSession(state.sessionName)
    if (!session) return

    const target = await attachTarget(session, targetId, url)
    if (!target) return

    // Poll for document.body readiness
    const proxy = createPageProxy(state.conn, target)
    for (let i = 0; i < 10; i++) {
      try {
        const hasBody = await proxy.evaluate("!!document.body")
        if (hasBody) break
      } catch { /* page might not be ready */ }
      await new Promise((r) => setTimeout(r, 200))
    }

    await checkAndRunApps(state, target)
  } finally {
    processingTargets.delete(targetId)
  }
}

async function checkAndRunApps(state: RunnerState, target: PageTarget): Promise<void> {
  if (!state.active) return

  const apps = loadApps()
  const proxy = createPageProxy(state.conn, target)

  for (const app of apps) {
    if (app.pageHandlers.length === 0) continue

    for (const handlerFile of app.pageHandlers) {
      const script = loadAppScript(app, handlerFile)
      if (!script) continue

      try {
        const module = loadAndEvalScript(script, handlerFile) as AppModule
        if (!module?.matcher || !module?.run) continue

        const sessionApp = getSessionApp(state, app.name)
        const sessionPage: SessionPage = { uuid: target.targetId }
        const lwe = createLweContext(app.name, app.dirPath)
        const matched = await module.matcher(proxy, lwe, sessionApp, sessionPage)

        if (matched) {
          let injectedSet = state.injectedTargets.get(target.targetId)
          if (!injectedSet) {
            injectedSet = new Set()
            state.injectedTargets.set(target.targetId, injectedSet)
          }
          const key = `${app.name}:${handlerFile}`
          if (injectedSet.has(key)) continue
          injectedSet.add(key)

          log.info({ app: app.name, handler: handlerFile, url: target.url }, "Running page handler")
          await module.run(proxy, lwe, sessionApp, sessionPage)
        }
      } catch (e) {
        if (!isStaleSessionError(e)) {
          log.error({ err: e, app: app.name, handler: handlerFile }, "Page handler error")
          addAppError(app.name, `Page handler ${handlerFile} error: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// CDP handlers
// ---------------------------------------------------------------------------

async function runCdpHandlers(state: RunnerState): Promise<void> {
  const apps = loadApps()

  for (const app of apps) {
    if (app.cdpHandlers.length === 0) continue

    const sessionApp = getSessionApp(state, app.name)
    const lwe = createCdpLwe(state, app)

    for (const handlerFile of app.cdpHandlers) {
      if (app.type === "package") {
        // Package-type: use import()
        try {
          const modulePath = join(app.dirPath, handlerFile)
          const mod = await import(modulePath)
          if (typeof mod.run === "function") {
            await mod.run(lwe, sessionApp)
          }
        } catch (e) {
          log.error({ err: e, app: app.name, handler: handlerFile }, "CDP handler import error")
          addAppError(app.name, `CDP handler ${handlerFile} error: ${e instanceof Error ? e.message : String(e)}`)
        }
      } else {
        // VM sandbox
        const script = loadAppScript(app, handlerFile)
        if (!script) continue

        try {
          const module = loadAndEvalCdpHandler(script, handlerFile) as CdpHandlerModule
          if (typeof module?.run === "function") {
            await module.run(lwe, sessionApp)
          }
        } catch (e) {
          log.error({ err: e, app: app.name, handler: handlerFile }, "CDP handler VM error")
          addAppError(app.name, `CDP handler ${handlerFile} error: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
  }
}

function createCdpLwe(state: RunnerState, app: AppDefinition): LweContext {
  const lwe = createLweContext(app.name, app.dirPath)

  // Augment with CDP access
  lwe.cdp = {
    onEvent(method: string, callback: (params: Record<string, unknown>, sessionId?: string) => void): void {
      const unsub = onEvent(state.conn, method, callback)
      state.cleanups.push(unsub)
    },
    sendCommand(method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs?: number): Promise<unknown> {
      return sendCommand(state.conn, method, params, sessionId, timeoutMs)
    },
  }

  return lwe
}

// ---------------------------------------------------------------------------
// Script evaluation helpers
// ---------------------------------------------------------------------------

function getSessionApp(state: RunnerState, appName: string): SessionApp {
  let sa = state.appSessions.get(appName)
  if (!sa) {
    sa = {}
    state.appSessions.set(appName, sa)
  }
  return sa
}

function loadAndEvalScript(code: string, filename: string): unknown {
  const exports: Record<string, unknown> = {}
  const module = { exports }
  const sandbox = {
    module,
    exports,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    Buffer,
    URL,
    URLSearchParams,
    JSON,
    Date,
    Math,
    RegExp,
    Error,
    Map,
    Set,
    Array,
    Object,
    String,
    Number,
    Boolean,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
  }

  runInNewContext(code, sandbox, { filename, timeout: 5000 })
  return module.exports
}

function loadAndEvalCdpHandler(code: string, filename: string): unknown {
  const exports: Record<string, unknown> = {}
  const module = { exports }
  const sandbox = {
    module,
    exports,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    Buffer,
    URL,
    URLSearchParams,
    JSON,
    Date,
    Math,
    RegExp,
    Error,
    Map,
    Set,
    Array,
    Object,
    String,
    Number,
    Boolean,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    fetch,
  }

  runInNewContext(code, sandbox, { filename, timeout: 30000 })
  return module.exports
}

// ---------------------------------------------------------------------------
// Info
// ---------------------------------------------------------------------------

export function getRunnerInfo(): { sessionName: string; pageCount: number }[] {
  return Array.from(runners.values()).map((state) => {
    const session = getSession(state.sessionName)
    return {
      sessionName: state.sessionName,
      pageCount: session?.targets.size ?? 0,
    }
  })
}
