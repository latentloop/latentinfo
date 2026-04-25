/**
 * Collector runner — orchestrates collector execution on matching browser pages.
 *
 * Replaces the generic "app runner" pattern with a statically-typed collector
 * system. Collectors are registered at startup, not discovered from disk.
 *
 * Uses raw CDP for all browser interaction:
 * - Target.setDiscoverTargets for detecting all pages (existing + new)
 * - Target.attachToTarget for per-page sessions
 * - Runtime.evaluate for page.evaluate()
 * - Page.captureScreenshot for page.screenshot()
 * - Runtime.addBinding for page->backend notifications
 */

import type { Client } from "@libsql/client"
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
import { createLogger } from "./logger.js"
import { loadCollectorConfig, onCollectorConfigChanged, offCollectorConfigChanged } from "./collector-config.js"
import * as panelFns from "./page-panel.js"
import * as resourceFns from "./page-resources.js"

const log = createLogger("runner")

/** Check if an error is a stale CDP session (tab closed / navigated away). */
function isStaleSessionError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  return e.message.includes("-32001") || e.message.includes("Session with given id not found")
}

// ---------------------------------------------------------------------------
// CollectorDefinition — the public API for registering collectors
// ---------------------------------------------------------------------------

export type CollectorDefinition = {
  id: string              // e.g., 'x' — drives directory, document tagging, state keys
  description: string     // Human-readable description of what the collector does
  urlPatterns: string[]   // URL patterns for matching pages
  initCollector?: (db: Client) => Promise<void>
  cdpHandler?: (session: CdpAccess, db: Client) => void
  pageHandler?: (page: PageProxy, db: Client) => void
  /** Action handler — injects panel UI + page-side logic. Fire-and-forget (async IIFE internally). */
  actionHandler?: (page: PageProxy, db: Client) => void
}

// ---------------------------------------------------------------------------
// CdpAccess — clean API for collector cdpHandlers
// ---------------------------------------------------------------------------

export interface CdpAccess {
  /** Register a persistent CDP event listener. Cleaned up on stop. */
  onEvent(method: string, callback: (params: Record<string, unknown>, sessionId?: string) => void): void
  /** Send a CDP command. */
  sendCommand(method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs?: number): Promise<unknown>
}

// ---------------------------------------------------------------------------
// Notification handlers — per-target callbacks for Runtime.bindingCalled
// ---------------------------------------------------------------------------

/** targetId -> list of callbacks */
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
// PageProxy — clean API for collector page handlers, backed by raw CDP
// ---------------------------------------------------------------------------

function createPageProxy(conn: CdpConnection, target: PageTarget, sessionCleanups?: (() => void)[]): PageProxy {
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

  const proxy: PageProxy = {
    get url() { return target.url },

    /**
     * Evaluate a function or string expression in the page context.
     * Functions are serialized via .toString() — they must be self-contained
     * (no closures over Node.js variables). Use `arg` to pass data.
     */
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    async evaluate(fn: string | Function, ...args: unknown[]): Promise<unknown> {
      let expression: string
      if (typeof fn === "function") {
        const argList = args.map((a) => JSON.stringify(a)).join(", ")
        expression = `(${fn.toString()})(${argList})`
      } else {
        expression = fn
      }
      return cdpEval(expression)
    },

    /**
     * Install a named module into the page's window.__latent namespace.
     * The module is a plain object of functions/values. Can be called
     * repeatedly to replace a previous version (hot-reload).
     *
     * Usage:
     *   page.installModule("x", {
     *     extractTweets: function() { ... },
     *     addBadges: function(items) { ... },
     *   });
     *
     * In-page access: window.__latent.x.extractTweets()
     */
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    async installModule(name: string, moduleObj: Record<string, Function | string | number | boolean>): Promise<void> {
      // Serialize each function via .toString(), keep primitives as JSON
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
      // Also expose each function as a window global so cross-function references
      // work (e.g., addBadges referencing cssEscape as a bare identifier).
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

    /**
     * Call a function from an installed module.
     * Returns the result. Supports passing a JSON-serializable argument.
     */
    async callModule(moduleName: string, fnName: string, arg?: unknown): Promise<unknown> {
      const argJson = arg !== undefined ? JSON.stringify(arg) : ""
      return cdpEval(`window.__latent[${JSON.stringify(moduleName)}][${JSON.stringify(fnName)}](${argJson})`)
    },

    async screenshot(options: Record<string, unknown> = {}): Promise<Buffer> {
      const formatOption = options.format ?? options.type
      const format = formatOption === "jpeg" || formatOption === "webp" ? formatOption : "png"
      const qualityRaw = typeof options.quality === "number" ? Math.round(options.quality) : null
      const quality = qualityRaw === null ? null : Math.max(1, Math.min(100, qualityRaw))
      const clipInput = options.clip as Record<string, unknown> | undefined
      const clip = clipInput && typeof clipInput.x === "number" && typeof clipInput.y === "number" &&
        typeof clipInput.width === "number" && typeof clipInput.height === "number"
        ? {
            x: clipInput.x,
            y: clipInput.y,
            width: clipInput.width,
            height: clipInput.height,
            scale: typeof clipInput.scale === "number" ? clipInput.scale : 1,
          }
        : undefined

      const params: Record<string, unknown> = {
        format,
        fromSurface: typeof options.fromSurface === "boolean" ? options.fromSurface : false,
        optimizeForSpeed: typeof options.optimizeForSpeed === "boolean" ? options.optimizeForSpeed : true,
        captureBeyondViewport: typeof options.captureBeyondViewport === "boolean"
          ? options.captureBeyondViewport
          : true,
      }
      if (quality !== null && format !== "png") params.quality = quality
      if (clip) params.clip = clip

      const result = await sendCommand(conn, "Page.captureScreenshot", params, sid) as { data: string }
      return Buffer.from(result.data, "base64")
    },

    /**
     * Register a callback for page->backend notifications.
     * The page calls window.__latentNotify(payload) and the callback fires.
     * Binding is set up automatically by the backend — no page-side setup needed.
     * Multiple handlers can be registered per target.
     */
    onNotify(callback: (payload: string) => void): void {
      registerNotifyHandler(target.targetId, callback)
    },

    async disposeCollector(collectorId: string): Promise<void> {
      try {
        await cdpEval(`
          if (window.__latent && window.__latent.__tracker) {
            window.__latent.__tracker.disposeCollector(${JSON.stringify(collectorId)});
          }
        `)
      } catch {
        // Page may already be gone — that's fine
      }
    },

    /**
     * Register a cleanup callback to run when the session ends.
     * Use this to deregister listeners, timers, or other resources
     * acquired during the action handler lifecycle.
     */
    onCleanup(callback: () => void): void {
      sessionCleanups?.push(callback)
    },
  }

  return proxy
}

export interface PageProxy {
  /** Current URL of the page */
  readonly url: string
  /** Evaluate a function or expression in the page context */
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  evaluate(fn: string | Function, ...args: unknown[]): Promise<unknown>
  /** Install a named module into window.__latent namespace */
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  installModule(name: string, moduleObj: Record<string, Function | string | number | boolean>): Promise<void>
  /** Call a function from an installed module */
  callModule(moduleName: string, fnName: string, arg?: unknown): Promise<unknown>
  /** Take a screenshot */
  screenshot(options?: Record<string, unknown>): Promise<Buffer>
  /** Register a notification handler */
  onNotify(callback: (payload: string) => void): void
  /** Dispose all page-side resources for a collector via ResourceTracker */
  disposeCollector(collectorId: string): Promise<void>
  /** Register a cleanup callback that runs when the session ends */
  onCleanup(callback: () => void): void
}

// ---------------------------------------------------------------------------
// Runner state
// ---------------------------------------------------------------------------

interface RunnerState {
  sessionName: string
  conn: CdpConnection
  /** targetId -> set of collector IDs that have been injected */
  injectedTargets: Map<string, Set<string>>
  /** targetId -> latest URL seen while the target was already being processed */
  pendingTargetUrls: Map<string, string>
  cleanups: (() => void)[]
  active: boolean
  /** True once cdpHandlers have finished — page handlers must wait for this. */
  cdpReady: boolean
}

const runners = new Map<string, RunnerState>()

// Tracks targets currently being processed to prevent concurrent handling
const processingTargets = new Set<string>()

const t0 = Date.now()
function ts() { return `+${Date.now() - t0}ms` }

type TargetInfoChangeDecision =
  | "ignore"
  | "clear"
  | "check-now"
  | "queue-check"
  | "attach-now"
  | "queue-attach"

type PageReadinessSnapshot = {
  hasBody: boolean
  readyState: string
  locationHref: string
}

function isPageReadyForCollectors(value: unknown): value is PageReadinessSnapshot {
  if (!value || typeof value !== "object") return false
  const snapshot = value as Record<string, unknown>
  return snapshot.hasBody === true &&
    typeof snapshot.readyState === "string" &&
    snapshot.readyState !== "loading" &&
    typeof snapshot.locationHref === "string" &&
    snapshot.locationHref.startsWith("http")
}

function decideTargetInfoChange(
  hasKnownTarget: boolean,
  previousUrl: string | null,
  nextUrl: string,
  isProcessing: boolean,
): TargetInfoChangeDecision {
  if (hasKnownTarget) {
    if (previousUrl === nextUrl) return "ignore"
    if (!nextUrl.startsWith("http")) return "clear"
    return isProcessing ? "queue-check" : "check-now"
  }

  if (!nextUrl.startsWith("http")) return "ignore"
  return isProcessing ? "queue-attach" : "attach-now"
}

// ---------------------------------------------------------------------------
// URL pattern matching
// ---------------------------------------------------------------------------

function matchesUrlPattern(url: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    // Support simple glob-like patterns: "https://x.com/*" or "https://*.twitter.com/*"
    const regex = new RegExp(
      "^" + pattern
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*") +
      "$"
    )
    if (regex.test(url)) return true
  }
  return false
}

function findMatchingCollectors(url: string, collectors: CollectorDefinition[]): CollectorDefinition[] {
  return collectors.filter((c) => matchesUrlPattern(url, c.urlPatterns))
}

// ---------------------------------------------------------------------------
// Start / Stop
// ---------------------------------------------------------------------------

export async function startCollectorRunner(
  sessionName: string,
  collectors: CollectorDefinition[],
  db: Client,
): Promise<void> {
  stopCollectorRunner(sessionName)

  const session = getSession(sessionName)
  if (!session) return

  const state: RunnerState = {
    sessionName,
    conn: session.conn,
    injectedTargets: new Map(),
    pendingTargetUrls: new Map(),
    cleanups: [],
    active: true,
    cdpReady: false,
  }
  runners.set(sessionName, state)

  const { conn } = session

  // 1. Register event listeners FIRST (before any discovery)

  // New page targets (for tabs opened after initial setup)
  const unsubCreated = onEvent(conn, "Target.targetCreated", (params) => {
    if (!state.active) return
    const info = params.targetInfo as { targetId: string; type: string; url: string }
    if (info.type !== "page") return
    if (!info.url.startsWith("http")) return
    log.debug(`${ts()} EVENT targetCreated: ${info.url.slice(0, 60)}`)
    handleNewTarget(state, info.targetId, info.url, collectors, db)
  })
  state.cleanups.push(unsubCreated)

  // URL changes — handles navigations on existing targets AND
  // new tabs that started as chrome://newtab then navigated to http
  const unsubChanged = onEvent(conn, "Target.targetInfoChanged", (params) => {
    if (!state.active) return
    const info = params.targetInfo as { targetId: string; type: string; url: string }
    if (info.type !== "page") return

    const target = session.targets.get(info.targetId)
    const decision = decideTargetInfoChange(
      Boolean(target),
      target?.url ?? null,
      info.url,
      processingTargets.has(info.targetId),
    )

    if (target) target.url = info.url

    switch (decision) {
      case "ignore":
        return
      case "clear":
        log.debug(`${ts()} EVENT targetInfoChanged (clear): ${info.url.slice(0, 60)}`)
        state.injectedTargets.delete(info.targetId)
        clearNotifyHandlers(info.targetId)
        state.pendingTargetUrls.delete(info.targetId)
        return
      case "queue-check":
      case "queue-attach":
        log.debug(`${ts()} EVENT targetInfoChanged (queued): ${info.url.slice(0, 60)}`)
        state.injectedTargets.delete(info.targetId)
        clearNotifyHandlers(info.targetId)
        state.pendingTargetUrls.set(info.targetId, info.url)
        return
      case "check-now":
        log.debug(`${ts()} EVENT targetInfoChanged: ${info.url.slice(0, 60)}`)
        state.injectedTargets.delete(info.targetId)
        clearNotifyHandlers(info.targetId)
        checkAndRunCollectors(state, target!, collectors, db).catch((e) => {
          if (!isStaleSessionError(e)) log.error(e, "checkAndRunCollectors error")
        })
        return
      case "attach-now":
        log.debug(`${ts()} EVENT targetInfoChanged (new): ${info.url.slice(0, 60)}`)
        handleNewTarget(state, info.targetId, info.url, collectors, db).catch((e) => {
          if (!isStaleSessionError(e)) log.error(e, "handleNewTarget error")
        })
        return
    }
  })
  state.cleanups.push(unsubChanged)

  // Target destruction — clean up handlers
  const unsubDestroyed = onEvent(conn, "Target.targetDestroyed", (params) => {
    const targetId = params.targetId as string
    state.injectedTargets.delete(targetId)
    clearNotifyHandlers(targetId)
    removeTarget(session, targetId)
  })
  state.cleanups.push(unsubDestroyed)

  // Page->backend notifications via Runtime.bindingCalled
  const unsubBinding = onEvent(conn, "Runtime.bindingCalled", (params, eventSid) => {
    if (!state.active) return
    if (params.name !== NOTIFY_BINDING_NAME) return

    // Find target by session ID and forward notification
    for (const target of session.targets.values()) {
      if (target.sessionId === eventSid) {
        dispatchNotify(target.targetId, params.payload as string)
        break
      }
    }
  })
  state.cleanups.push(unsubBinding)

  // Page refresh / hard navigation — page context is destroyed, so injected
  // modules are gone. Always clear and re-inject.
  const unsubFrameNav = onEvent(conn, "Page.frameNavigated", (params, eventSid) => {
    if (!state.active) return
    const frame = params.frame as { url?: string; parentFrameId?: string; parentId?: string } | undefined
    if (!frame?.url?.startsWith("http")) return
    // Only main frame
    if (frame.parentFrameId || frame.parentId) return

    // Find target by session ID
    for (const target of session.targets.values()) {
      if (target.sessionId === eventSid) {
        log.debug(`${ts()} EVENT frameNavigated: ${frame.url.slice(0, 60)}`)
        state.injectedTargets.delete(target.targetId)
        clearNotifyHandlers(target.targetId)
        target.url = frame.url
        checkAndRunCollectors(state, target, collectors, db).catch((e) => {
          if (!isStaleSessionError(e)) log.error(e, "checkAndRunCollectors error")
        })
        break
      }
    }
  })
  state.cleanups.push(unsubFrameNav)

  // 2. Enable target discovery EARLY so tabs opened during startup are detected.
  await sendCommand(conn, "Target.setDiscoverTargets", { discover: true })

  // 3. Run cdpHandlers (once per session, before page handlers)
  await runCdpHandlers(state, collectors, db)
  state.cdpReady = true

  // 4. Attach to existing http page targets — in parallel
  const result = await sendCommand(conn, "Target.getTargets") as {
    targetInfos: { targetId: string; type: string; url: string }[]
  }
  const pageTargets = result.targetInfos.filter(
    (t) => t.type === "page" && t.url.startsWith("http"),
  )
  await Promise.all(
    pageTargets.map((info) => handleNewTarget(state, info.targetId, info.url, collectors, db)),
  )

  // 5. Listen for collector config changes (enable/disable toggle)
  const configHandler = (collectorId: string, config: { enabled?: boolean }) => {
    if (!state.active) return
    const session = getSession(state.sessionName)
    if (!session) return

    if (config.enabled === false) {
      // Disable: clean up injected resources for this collector on all targets
      log.info({ collectorId }, "Collector disabled, cleaning up injected targets")
      for (const [targetId, injectedSet] of state.injectedTargets) {
        if (!injectedSet.has(collectorId) && !injectedSet.has(collectorId + ":action")) continue
        const target = session.targets.get(targetId)
        if (!target) continue
        const proxy = createPageProxy(state.conn, target)
        // Clean up page-side resources via ResourceTracker
        proxy.disposeCollector(collectorId).catch(() => {})
        // Remove panel section
        proxy.callModule("__panel", "__panelRemoveSection", collectorId).catch(() => {})
        // Remove installed modules (collector ID + "li_" prefixed module name convention)
        const moduleKey = JSON.stringify("li_" + collectorId)
        proxy.evaluate(`delete window.__latent[${JSON.stringify(collectorId)}]; delete window.__latent[${moduleKey}]`).catch(() => {})
        injectedSet.delete(collectorId)
        injectedSet.delete(collectorId + ":action")
      }
    } else {
      // Enable: re-inject on all matching targets
      log.info({ collectorId }, "Collector enabled, re-injecting on matching targets")
      const def = collectors.find((c) => c.id === collectorId)
      if (!def) return
      for (const [targetId] of state.injectedTargets) {
        const target = session.targets.get(targetId)
        if (!target) continue
        if (!matchesUrlPattern(target.url, def.urlPatterns)) continue
        const injectedSet = state.injectedTargets.get(targetId)
        if (injectedSet?.has(collectorId)) continue // already injected
        checkAndRunCollectors(state, target, collectors, db).catch((e) => {
          if (!isStaleSessionError(e)) log.error(e, "Re-injection error")
        })
      }
    }
  }
  onCollectorConfigChanged(configHandler)
  state.cleanups.push(() => offCollectorConfigChanged(configHandler))

  log.info(`Collector runner started for session: ${sessionName} (${session.targets.size} pages)`)
}

export function stopCollectorRunner(sessionName: string): void {
  const state = runners.get(sessionName)
  if (!state) return

  state.active = false
  for (const cleanup of state.cleanups) cleanup()
  const clearedTargets = new Set<string>()
  for (const targetId of state.injectedTargets.keys()) {
    clearNotifyHandlers(targetId)
    clearedTargets.add(targetId)
  }
  const session = getSession(sessionName)
  if (session) {
    for (const targetId of session.targets.keys()) {
      if (clearedTargets.has(targetId)) continue
      clearNotifyHandlers(targetId)
    }
  }
  state.injectedTargets.clear()
  state.pendingTargetUrls.clear()
  runners.delete(sessionName)
  log.info(`Collector runner stopped for session: ${sessionName}`)
}

// ---------------------------------------------------------------------------
// Target handling
// ---------------------------------------------------------------------------

async function handleNewTarget(
  state: RunnerState,
  targetId: string,
  url: string,
  collectors: CollectorDefinition[],
  db: Client,
): Promise<void> {
  // Skip until cdpHandlers have finished
  if (!state.cdpReady) return
  // Skip if already injected or currently being processed
  if (state.injectedTargets.has(targetId)) return
  if (processingTargets.has(targetId)) return
  processingTargets.add(targetId)

  try {
    const session = getSession(state.sessionName)
    if (!session) return

    log.debug(`${ts()} handleNewTarget: attaching ${url.slice(0, 60)}`)
    const target = await attachTarget(session, targetId, url)
    if (!target) return
    log.debug(`${ts()} handleNewTarget: attached, waiting for page readiness`)

    let pageReady = false
    for (let i = 0; i < 10; i++) {
      try {
        const r = await sendCommand(state.conn, "Runtime.evaluate", {
          expression: `({
            hasBody: !!document.body,
            readyState: document.readyState,
            locationHref: location.href
          })`,
          returnByValue: true,
        }, target.sessionId, 3000) as { result: { value: unknown } }
        if (isPageReadyForCollectors(r.result.value)) {
          pageReady = true
          target.url = r.result.value.locationHref
          break
        }
      } catch { /* page not ready */ }
      log.debug(`${ts()} handleNewTarget: page not ready, waiting (attempt ${i + 1})`)
      await new Promise<void>((resolve) => {
        const unsub = onEvent(state.conn, "Page.lifecycleEvent", (_, sid) => {
          if (sid === target.sessionId) { unsub(); resolve() }
        })
        setTimeout(() => { unsub(); resolve() }, 500)
      })
    }
    if (!pageReady) { log.debug(`${ts()} handleNewTarget: page never became ready, skipping`); return }
    log.debug(`${ts()} handleNewTarget: page ready, running collectors`)

    await checkAndRunCollectors(state, target, collectors, db)
    log.debug(`${ts()} handleNewTarget: done`)
  } finally {
    processingTargets.delete(targetId)

    const pendingUrl = state.pendingTargetUrls.get(targetId)
    if (!pendingUrl || !state.active) return

    state.pendingTargetUrls.delete(targetId)
    const session = getSession(state.sessionName)
    if (!session) return

    const pendingTarget = session.targets.get(targetId)
    if (pendingTarget) {
      pendingTarget.url = pendingUrl
      if (!pendingUrl.startsWith("http")) {
        state.injectedTargets.delete(targetId)
        clearNotifyHandlers(targetId)
        return
      }
      checkAndRunCollectors(state, pendingTarget, collectors, db).catch((e) => {
        if (!isStaleSessionError(e)) log.error(e, "checkAndRunCollectors error")
      })
      return
    }

    if (!pendingUrl.startsWith("http")) return
    handleNewTarget(state, targetId, pendingUrl, collectors, db).catch((e) => {
      if (!isStaleSessionError(e)) log.error(e, "handleNewTarget error")
    })
  }
}

async function checkAndRunCollectors(
  state: RunnerState,
  target: PageTarget,
  collectors: CollectorDefinition[],
  db: Client,
): Promise<void> {
  if (!state.active) return
  if (!target.url.startsWith("http")) return

  const matching = findMatchingCollectors(target.url, collectors)
    .filter((c) => loadCollectorConfig(c.id).enabled !== false)
  if (matching.length === 0) return

  let injected = state.injectedTargets.get(target.targetId)
  if (!injected) {
    injected = new Set()
    state.injectedTargets.set(target.targetId, injected)
  }

  const proxy = createPageProxy(state.conn, target, state.cleanups)

  // Install shared resource tracker module (once per page per backend process).
  //
  // Reattach idempotency: when a prior backend process left resources registered
  // on this page (tracker + orphaned observers/listeners), we dispose everything
  // before replacing the tracker reference. Without this, the old observers keep
  // firing against a closed CDP binding and throw ReferenceError.
  //
  // The stub of __latentOnUrlMaybeChanged runs FIRST so the old history.pushState
  // monkey-patch wrapper can't fire a stale closure during the install window.
  if (!injected.has("__resources")) {
    try {
      await proxy.evaluate(`(function() {
        window.__latentOnUrlMaybeChanged = function() {};
        if (window.__latent && window.__latent.__tracker && typeof window.__latent.__tracker.disposeAll === "function") {
          try { window.__latent.__tracker.disposeAll(); } catch (e) {}
        }
      })()`)
      await proxy.installModule("__resources", {
        createResourceTracker: resourceFns.createResourceTracker,
      })
      await proxy.evaluate("window.__latent.__tracker = window.__latent.__resources.createResourceTracker()")
      injected.add("__resources")
    } catch (e) {
      if (!isStaleSessionError(e)) log.error(e, "ResourceTracker install error")
    }
  }

  // Pass 1: Run page handlers (fire-and-forget — async work continues in background)
  for (const collector of matching) {
    if (injected.has(collector.id)) continue

    try {
      // Per-collector reattach safety: clean any residual state registered
      // under this collector's bucket from a prior same-process re-entry path
      // (enable → disable → enable, or frameNavigated re-inject). No-op on
      // cold start. Audit: all current action handlers register under
      // collector.id (same as pageHandler), so Pass 2 does NOT re-dispose.
      await proxy.disposeCollector(collector.id)

      injected.add(collector.id)
      log.debug(`${ts()} checkAndRunCollectors: running "${collector.id}" on ${target.url.slice(0, 40)}`)

      if (collector.pageHandler) {
        collector.pageHandler(proxy, db)
      }
    } catch (e) {
      if (isStaleSessionError(e)) {
        log.debug(`Collector "${collector.id}" aborted (session gone)`)
      } else {
        log.error(e, `Collector "${collector.id}" error`)
      }
    }
  }

  // Pass 2: Run action handlers (panel UI + page-side logic)
  const actionCollectors = matching.filter(
    (c) => c.actionHandler && !injected.has(c.id + ":action"),
  )
  if (actionCollectors.length > 0) {
    // Install shared panel module (awaited — prerequisite for action handlers)
    try {
      await proxy.installModule("__panel", {
        __panelCreate: panelFns.__panelCreate,
        __panelAddSection: panelFns.__panelAddSection,
        __panelRemoveSection: panelFns.__panelRemoveSection,
        __panelIsCreated: panelFns.__panelIsCreated,
      })
      await proxy.callModule("__panel", "__panelCreate")
    } catch (e) {
      if (!isStaleSessionError(e)) log.error(e, "Panel module install error")
      return
    }

    for (const collector of actionCollectors) {
      try {
        log.debug(`${ts()} checkAndRunCollectors: action "${collector.id}" on ${target.url.slice(0, 40)}`)
        collector.actionHandler!(proxy, db)
        injected.add(collector.id + ":action")
      } catch (e) {
        if (isStaleSessionError(e)) {
          log.debug(`Action "${collector.id}" aborted (session gone)`)
        } else {
          log.error(e, `Action "${collector.id}" error`)
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// CDP handlers (run once per session)
// ---------------------------------------------------------------------------

async function runCdpHandlers(
  state: RunnerState,
  collectors: CollectorDefinition[],
  db: Client,
): Promise<void> {
  for (const collector of collectors) {
    if (!collector.cdpHandler) continue

    const cdpAccess: CdpAccess = {
      onEvent(method: string, callback: (params: Record<string, unknown>, sessionId?: string) => void): void {
        const unsub = onEvent(state.conn, method, callback)
        state.cleanups.push(unsub)
      },
      sendCommand(method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs?: number): Promise<unknown> {
        return sendCommand(state.conn, method, params ?? {}, sessionId, timeoutMs)
      },
    }

    try {
      log.debug(`${ts()} runCdpHandlers: running "${collector.id}"`)
      collector.cdpHandler(cdpAccess, db)
      log.debug(`${ts()} runCdpHandlers: "${collector.id}" done`)
    } catch (e) {
      if (isStaleSessionError(e)) {
        log.debug(`CDP handler "${collector.id}" aborted (session gone)`)
      } else {
        log.error(e, `CDP handler "${collector.id}" error`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Info
// ---------------------------------------------------------------------------

export function getRunnerInfo(): { sessionName: string; pageCount: number }[] {
  return Array.from(runners.entries()).map(([name, state]) => ({
    sessionName: name,
    pageCount: state.injectedTargets.size,
  }))
}

export const __test__ = {
  decideTargetInfoChange,
  isPageReadyForCollectors,
}
