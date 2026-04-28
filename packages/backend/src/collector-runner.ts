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
const ACTIVATION_NOTIFY_KEY = "__latent:page-activation"
const LOCATION_CHECK_DEDUPE_MS = 1000
const INITIAL_REST_ATTACH_CONCURRENCY = 3
const STALE_TARGET_GENERATION_ERROR = "CDP command skipped: stale target generation"
const ACTIVE_PAGE_COMMAND_PRIORITY = 100

/** Check if an error is a stale CDP session (tab closed / navigated away). */
function isStaleSessionError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  return e.message.includes("-32001") ||
    e.message.includes("Session with given id not found") ||
    e.message.includes("CDP session closed") ||
    e.message.includes("CDP not connected") ||
    e.message.includes(STALE_TARGET_GENERATION_ERROR)
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
  /** Re-run pageHandler on SPA URL changes after initial injection, without tearing down page resources. */
  rerunPageHandlerOnUrlChange?: boolean
  /** Action handler — injects panel UI + page-side logic. Fire-and-forget (async IIFE internally). */
  actionHandler?: (page: PageProxy, db: Client) => void
}

export type ActiveTabHint = {
  url: string
  title?: string
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

class CdpCommandQueue {
  private lanes = new Map<string, {
    running: boolean
    sequence: number
    jobs: Array<{
      targetId: string
      generation: number
      priority: number
      sequence: number
      operation: () => Promise<unknown>
      resolve: (value: unknown) => void
      reject: (error: Error) => void
    }>
  }>()
  private generations = new Map<string, number>()

  private key(targetId: string, lane: string): string {
    return `${targetId}:${lane}`
  }

  private getLane(key: string) {
    let queue = this.lanes.get(key)
    if (!queue) {
      queue = { running: false, sequence: 0, jobs: [] }
      this.lanes.set(key, queue)
    }
    return queue
  }

  private staleGenerationError(): Error {
    return new Error(STALE_TARGET_GENERATION_ERROR)
  }

  private rejectPendingTargetJobs(targetId: string): void {
    for (const [key, queue] of this.lanes) {
      if (!key.startsWith(`${targetId}:`)) continue
      for (const job of queue.jobs) job.reject(this.staleGenerationError())
      queue.jobs = []
      if (!queue.running) this.lanes.delete(key)
    }
  }

  private drain(key: string): void {
    const queue = this.lanes.get(key)
    if (!queue || queue.running) return
    const job = queue.jobs.shift()
    if (!job) {
      this.lanes.delete(key)
      return
    }

    queue.running = true
    void (async () => {
      try {
        if (this.generation(job.targetId) !== job.generation) {
          throw this.staleGenerationError()
        }
        job.resolve(await job.operation())
      } catch (e) {
        job.reject(e instanceof Error ? e : new Error(String(e)))
      } finally {
        const latest = this.lanes.get(key)
        if (latest) {
          latest.running = false
          queueMicrotask(() => this.drain(key))
        }
      }
    })()
  }

  generation(targetId: string): number {
    return this.generations.get(targetId) ?? 0
  }

  invalidate(targetId: string): number {
    const next = this.generation(targetId) + 1
    this.generations.set(targetId, next)
    this.rejectPendingTargetJobs(targetId)
    return next
  }

  clear(targetId: string): void {
    this.rejectPendingTargetJobs(targetId)
    this.generations.delete(targetId)
  }

  clearAll(): void {
    for (const queue of this.lanes.values()) {
      for (const job of queue.jobs) job.reject(this.staleGenerationError())
      queue.jobs = []
    }
    this.lanes.clear()
    this.generations.clear()
  }

  enqueue<T>(
    targetId: string,
    generation: number,
    lane: string,
    operation: () => Promise<T>,
    priority = 0,
  ): Promise<T> {
    const key = this.key(targetId, lane)
    const queue = this.getLane(key)

    return new Promise<T>((resolve, reject) => {
      const job = {
        targetId,
        generation,
        priority,
        sequence: queue.sequence++,
        operation: operation as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      }
      if (priority > 0) {
        const insertAt = queue.jobs.findIndex((candidate) =>
          candidate.priority < priority ||
          (candidate.priority === priority && candidate.sequence > job.sequence)
        )
        if (insertAt === -1) queue.jobs.push(job)
        else queue.jobs.splice(insertAt, 0, job)
      } else {
        queue.jobs.push(job)
      }
      this.drain(key)
    })
  }
}

function createPageProxy(
  conn: CdpConnection,
  target: PageTarget,
  sessionCleanups?: (() => void)[],
  commandQueue?: CdpCommandQueue,
  commandGeneration?: number,
  commandPriority?: () => number,
  defaultLane = "default",
): PageProxy {
  const sid = target.sessionId

  function enqueueCdpCommand<T>(operation: () => Promise<T>, lane = defaultLane): Promise<T> {
    if (!commandQueue || commandGeneration === undefined) return operation()
    return commandQueue.enqueue(target.targetId, commandGeneration, lane, operation, commandPriority?.() ?? 0)
  }

  async function cdpEval(expression: string, lane?: string): Promise<unknown> {
    const result = await enqueueCdpCommand(() => sendCommand(conn, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, sid), lane) as { result: { value: unknown }; exceptionDetails?: unknown }

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
    async callModule(moduleName: string, fnName: string, arg?: unknown, options?: { lane?: string }): Promise<unknown> {
      const argJson = arg !== undefined ? JSON.stringify(arg) : ""
      return cdpEval(`window.__latent[${JSON.stringify(moduleName)}][${JSON.stringify(fnName)}](${argJson})`, options?.lane)
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

      const result = await enqueueCdpCommand(() => sendCommand(conn, "Page.captureScreenshot", params, sid)) as { data: string }
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
  callModule(moduleName: string, fnName: string, arg?: unknown, options?: { lane?: string }): Promise<unknown>
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

interface TargetRuntimeState {
  targetId: string
  url: string
  injected: Set<string>
  activationProbeId: string | null
  pendingUrl: string | null
  pendingCheck: CollectorCheckReason | null
  processing: boolean
  checking: boolean
  lastLocationCheck: { url: string; at: number } | null
  commandGeneration: number
  pageActive: boolean
}

interface RunnerState {
  sessionName: string
  conn: CdpConnection
  /** targetId -> page lifecycle/injection state */
  targets: Map<string, TargetRuntimeState>
  /** Serialized page CDP command queue with generation invalidation. */
  commandQueue: CdpCommandQueue
  /** Unique token written into page probes so reconnects can replace stale handlers. */
  activationProbeId: string
  cleanups: (() => void)[]
  active: boolean
  /** True once cdpHandlers have finished — page handlers must wait for this. */
  cdpReady: boolean
}

const runners = new Map<string, RunnerState>()

const t0 = Date.now()
function ts() { return `+${Date.now() - t0}ms` }

type TargetInfoChangeDecision =
  | "ignore"
  | "clear"
  | "update-url"
  | "check-now"
  | "queue-check"
  | "attach-now"
  | "queue-attach"

type PageReadinessSnapshot = {
  hasBody: boolean
  readyState: string
  locationHref: string
}

type PageActivationSnapshot = PageReadinessSnapshot & {
  visibilityState: string
  hasFocus: boolean
}

type TargetAttachReason = "initial" | "initial-active" | "created" | "location-change" | "config-enable"
type CollectorCheckReason = "initial-visible" | "activation" | "location-change" | "frame-navigation" | "config-enable"

type ActivationNotifySignal = {
  key: typeof ACTIVATION_NOTIFY_KEY
  reason: string
  detectedAt: number
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

function isPageActiveForCollectors(value: unknown): value is PageActivationSnapshot {
  if (!isPageReadyForCollectors(value)) return false
  const snapshot = value as Record<string, unknown>
  return typeof snapshot.visibilityState === "string" &&
    typeof snapshot.hasFocus === "boolean" &&
    (snapshot.visibilityState === "visible" || snapshot.hasFocus === true)
}

function updateRuntimePageActivity(runtime: TargetRuntimeState, snapshot: unknown): void {
  runtime.pageActive = isPageActiveForCollectors(snapshot)
}

function shouldRunCollectorsAfterAttach(reason: TargetAttachReason, snapshot: unknown): boolean {
  if (!isPageReadyForCollectors(snapshot)) return false
  if (reason === "location-change" || reason === "initial-active" || reason === "config-enable") return true
  return isPageActiveForCollectors(snapshot)
}

function parseActivationNotifyPayload(payload: unknown): ActivationNotifySignal | null {
  if (typeof payload !== "string") return null
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>
    if (parsed.key !== ACTIVATION_NOTIFY_KEY) return null
    return {
      key: ACTIVATION_NOTIFY_KEY,
      reason: typeof parsed.reason === "string" ? parsed.reason : "unknown",
      detectedAt: typeof parsed.detectedAt === "number" ? parsed.detectedAt : Date.now(),
    }
  } catch {
    return null
  }
}

function isDuplicateLocationCheck(
  previous: { url: string; at: number } | undefined,
  nextUrl: string,
  now: number,
): boolean {
  return Boolean(previous && previous.url === nextUrl && now - previous.at < LOCATION_CHECK_DEDUPE_MS)
}

function isHashOnlyUrlChange(previousUrl: string | null, nextUrl: string): boolean {
  if (!previousUrl || previousUrl === nextUrl) return false
  try {
    const previous = new URL(previousUrl)
    const next = new URL(nextUrl)
    previous.hash = ""
    next.hash = ""
    return previous.toString() === next.toString()
  } catch {
    return false
  }
}

function decideTargetInfoChange(
  hasKnownTarget: boolean,
  previousUrl: string | null,
  nextUrl: string,
  isProcessing: boolean,
  hasCompleteInjection = false,
): TargetInfoChangeDecision {
  if (hasKnownTarget) {
    if (previousUrl === nextUrl) return "ignore"
    if (!nextUrl.startsWith("http")) return "clear"
    if (hasCompleteInjection) return "update-url"
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

function hasEnabledMatchingCollectors(url: string, collectors: CollectorDefinition[]): boolean {
  return findMatchingCollectors(url, collectors).some((c) => loadCollectorConfig(c.id).enabled !== false)
}

function hasCompleteCollectorInjection(injectedSet: Set<string> | undefined, collector: CollectorDefinition): boolean {
  if (!injectedSet?.has(collector.id)) return false
  return !collector.actionHandler || injectedSet.has(collector.id + ":action")
}

type TargetInfo = {
  targetId: string
  type: string
  url: string
  title?: string
}

function urlsMatchActiveHint(targetUrl: string, hintUrl: string): boolean {
  if (targetUrl === hintUrl) return true
  try {
    const target = new URL(targetUrl)
    const hint = new URL(hintUrl)
    target.hash = ""
    hint.hash = ""
    return target.toString() === hint.toString()
  } catch {
    return false
  }
}

function targetMatchesActiveHint(target: TargetInfo, activeTabHint: ActiveTabHint | undefined): boolean {
  if (!activeTabHint?.url.startsWith("http")) return false
  if (!target.url.startsWith("http")) return false
  return urlsMatchActiveHint(target.url, activeTabHint.url)
}

function orderPageTargetsForInitialAttach(
  pageTargets: TargetInfo[],
  activeTabHint: ActiveTabHint | undefined,
): { active: TargetInfo[]; rest: TargetInfo[] } {
  const active: TargetInfo[] = []
  const rest: TargetInfo[] = []
  for (const target of pageTargets) {
    if (targetMatchesActiveHint(target, activeTabHint)) active.push(target)
    else rest.push(target)
  }
  return { active, rest }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return

  let nextIndex = 0
  const workerCount = Math.max(1, Math.min(concurrency, items.length))
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const item = items[nextIndex]
      nextIndex += 1
      if (item === undefined) return
      await run(item)
    }
  })

  await Promise.all(workers)
}

function getOrCreateTargetState(state: RunnerState, targetId: string, url: string): TargetRuntimeState {
  let runtime = state.targets.get(targetId)
  if (!runtime) {
    runtime = {
      targetId,
      url,
      injected: new Set(),
      activationProbeId: null,
      pendingUrl: null,
      pendingCheck: null,
      processing: false,
      checking: false,
      lastLocationCheck: null,
      commandGeneration: state.commandQueue.generation(targetId),
      pageActive: false,
    }
    state.targets.set(targetId, runtime)
  } else {
    runtime.url = url
  }
  return runtime
}

function invalidateTargetCommands(state: RunnerState, runtime: TargetRuntimeState): void {
  runtime.commandGeneration = state.commandQueue.invalidate(runtime.targetId)
}

function clearTargetRuntime(state: RunnerState, targetId: string, remove = false): void {
  const runtime = state.targets.get(targetId)
  if (runtime) {
    runtime.injected.clear()
    runtime.activationProbeId = null
    runtime.pendingUrl = null
    runtime.pendingCheck = null
    runtime.checking = false
    runtime.processing = false
    runtime.lastLocationCheck = null
    runtime.pageActive = false
    invalidateTargetCommands(state, runtime)
  } else {
    state.commandQueue.invalidate(targetId)
  }
  clearNotifyHandlers(targetId)
  if (remove) {
    state.targets.delete(targetId)
    state.commandQueue.clear(targetId)
  }
}

function findMatchingEnabledCollectors(url: string, collectors: CollectorDefinition[]): CollectorDefinition[] {
  return findMatchingCollectors(url, collectors)
    .filter((c) => loadCollectorConfig(c.id).enabled !== false)
}

function hasCompleteMatchingInjection(runtime: TargetRuntimeState | undefined, url: string, collectors: CollectorDefinition[]): boolean {
  if (!runtime) return false
  const matching = findMatchingEnabledCollectors(url, collectors)
  return matching.length > 0 && matching.every((collector) => hasCompleteCollectorInjection(runtime.injected, collector))
}

function getUrlChangePageHandlerCollectors(
  url: string,
  collectors: CollectorDefinition[],
  injected: Set<string>,
): CollectorDefinition[] {
  return findMatchingEnabledCollectors(url, collectors)
    .filter((collector) =>
      collector.rerunPageHandlerOnUrlChange === true &&
      Boolean(collector.pageHandler) &&
      injected.has(collector.id)
    )
}

function createRuntimePageProxy(
  state: RunnerState,
  target: PageTarget,
  runtime: TargetRuntimeState,
  sessionCleanups?: (() => void)[],
  defaultLane?: string,
): PageProxy {
  return createPageProxy(
    state.conn,
    target,
    sessionCleanups,
    state.commandQueue,
    runtime.commandGeneration,
    () => runtime.pageActive ? ACTIVE_PAGE_COMMAND_PRIORITY : 0,
    defaultLane,
  )
}

// ---------------------------------------------------------------------------
// Start / Stop
// ---------------------------------------------------------------------------

export async function startCollectorRunner(
  sessionName: string,
  collectors: CollectorDefinition[],
  db: Client,
  activeTabHint?: ActiveTabHint,
): Promise<boolean> {
  stopCollectorRunner(sessionName)

  const session = getSession(sessionName)
  if (!session) return false

  const state: RunnerState = {
    sessionName,
    conn: session.conn,
    targets: new Map(),
    commandQueue: new CdpCommandQueue(),
    activationProbeId: `${sessionName}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    cleanups: [],
    active: true,
    cdpReady: false,
  }
  runners.set(sessionName, state)

  const { conn } = session

  try {
    // 1. Register event listeners FIRST (before any discovery)

    // New page targets (for tabs opened after initial setup)
    const unsubCreated = onEvent(conn, "Target.targetCreated", (params) => {
      if (!state.active) return
      const info = params.targetInfo as { targetId: string; type: string; url: string }
      if (info.type !== "page") return
      if (!info.url.startsWith("http")) return
      if (!hasEnabledMatchingCollectors(info.url, collectors)) return
      log.debug(`${ts()} EVENT targetCreated: ${info.url.slice(0, 60)}`)
      handleNewTarget(state, info.targetId, info.url, collectors, db, "created").catch((e) => {
        if (!isStaleSessionError(e)) log.error(e, "handleNewTarget error")
      })
    })
    state.cleanups.push(unsubCreated)

    // URL changes — handles navigations on existing targets AND
    // new tabs that started as chrome://newtab then navigated to http.
    const unsubChanged = onEvent(conn, "Target.targetInfoChanged", (params) => {
      if (!state.active) return
      const info = params.targetInfo as { targetId: string; type: string; url: string }
      if (info.type !== "page") return

      const target = session.targets.get(info.targetId)
      const runtime = state.targets.get(info.targetId)
      const previousUrl = target?.url ?? runtime?.url ?? null
      const decision = decideTargetInfoChange(
        Boolean(target),
        previousUrl,
        info.url,
        runtime?.processing === true,
        hasCompleteMatchingInjection(runtime, info.url, collectors),
      )

      if (target) target.url = info.url
      if (runtime) runtime.url = info.url

      switch (decision) {
        case "ignore":
          return
        case "clear":
          log.debug(`${ts()} EVENT targetInfoChanged (clear): ${info.url.slice(0, 60)}`)
          clearTargetRuntime(state, info.targetId)
          return
        case "update-url":
          log.debug(`${ts()} EVENT targetInfoChanged (url-update): ${info.url.slice(0, 60)}`)
          if (target && runtime && !isHashOnlyUrlChange(previousUrl, info.url)) {
            runUrlChangePageHandlers(state, target, collectors, db, runtime)
          }
          return
        case "queue-check": {
          log.debug(`${ts()} EVENT targetInfoChanged (queued): ${info.url.slice(0, 60)}`)
          const queued = getOrCreateTargetState(state, info.targetId, info.url)
          queued.pendingUrl = info.url
          return
        }
        case "queue-attach": {
          log.debug(`${ts()} EVENT targetInfoChanged (queued): ${info.url.slice(0, 60)}`)
          const queued = getOrCreateTargetState(state, info.targetId, info.url)
          queued.pendingUrl = info.url
          queued.injected.clear()
          queued.activationProbeId = null
          clearNotifyHandlers(info.targetId)
          invalidateTargetCommands(state, queued)
          return
        }
        case "check-now":
          if (!target) return
          log.debug(`${ts()} EVENT targetInfoChanged: ${info.url.slice(0, 60)}`)
          clearTargetRuntime(state, info.targetId)
          scheduleCollectorCheck(state, target, collectors, db, "location-change")
          return
        case "attach-now":
          if (!hasEnabledMatchingCollectors(info.url, collectors)) return
          log.debug(`${ts()} EVENT targetInfoChanged (new): ${info.url.slice(0, 60)}`)
          handleNewTarget(state, info.targetId, info.url, collectors, db, "location-change").catch((e) => {
            if (!isStaleSessionError(e)) log.error(e, "handleNewTarget error")
          })
          return
      }
    })
    state.cleanups.push(unsubChanged)

    // Target destruction — clean up handlers
    const unsubDestroyed = onEvent(conn, "Target.targetDestroyed", (params) => {
      const targetId = params.targetId as string
      clearTargetRuntime(state, targetId, true)
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
        const activation = parseActivationNotifyPayload(params.payload)
        if (activation) {
          handleActivationNotification(state, target, collectors, db).catch((e) => {
            if (!isStaleSessionError(e)) log.error(e, "activation notification error")
          })
          return
        }
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
          clearTargetRuntime(state, target.targetId)
          target.url = frame.url
          getOrCreateTargetState(state, target.targetId, frame.url)
          scheduleCollectorCheck(state, target, collectors, db, "frame-navigation")
          break
        }
      }
    })
    state.cleanups.push(unsubFrameNav)

    // 2. Enable target discovery EARLY so tabs opened during startup are detected.
    await sendCommand(conn, "Target.setDiscoverTargets", { discover: true })
    if (!isRunnerCurrent(state)) return false

    // 3. Run cdpHandlers (once per session, before page handlers)
    await runCdpHandlers(state, collectors, db)
    if (!isRunnerCurrent(state)) return false
    state.cdpReady = true

    // 4. Attach to existing http page targets. Keep startup CDP pressure bounded:
    // the handlers themselves may install several scripts/actions per page.
    const result = await sendCommand(conn, "Target.getTargets") as {
      targetInfos: TargetInfo[]
    }
    if (!isRunnerCurrent(state)) return false
    const pageTargets = result.targetInfos.filter(
      (t) => t.type === "page" && t.url.startsWith("http") && hasEnabledMatchingCollectors(t.url, collectors),
    )
    const orderedTargets = orderPageTargetsForInitialAttach(pageTargets, activeTabHint)
    if (activeTabHint?.url) {
      log.debug({
        activeTabUrl: activeTabHint.url,
        matchedTargets: orderedTargets.active.length,
      }, "Initial active-tab hint")
    }
    for (const info of orderedTargets.active) {
      if (!isRunnerCurrent(state)) return false
      await handleNewTarget(state, info.targetId, info.url, collectors, db, "initial-active")
    }
    await runWithConcurrency(orderedTargets.rest, INITIAL_REST_ATTACH_CONCURRENCY, async (info) => {
      if (!isRunnerCurrent(state)) return
      await handleNewTarget(state, info.targetId, info.url, collectors, db, "initial")
    })

    // 5. Listen for collector config changes (enable/disable toggle)
    const configHandler = (collectorId: string, config: { enabled?: boolean }) => {
      if (!state.active) return
      const session = getSession(state.sessionName)
      if (!session) return

      if (config.enabled === false) {
        // Disable: clean up injected resources for this collector on all targets
        log.info({ collectorId }, "Collector disabled, cleaning up injected targets")
        for (const [targetId, runtime] of state.targets) {
          if (!runtime.injected.has(collectorId) && !runtime.injected.has(collectorId + ":action")) continue
          const target = session.targets.get(targetId)
          if (!target) continue
          const proxy = createRuntimePageProxy(state, target, runtime)
          // Clean up page-side resources via ResourceTracker
          proxy.disposeCollector(collectorId).catch(() => {})
          // Remove panel section
          proxy.callModule("__panel", "__panelRemoveSection", collectorId).catch(() => {})
          // Remove installed modules (collector ID + "li_" prefixed module name convention)
          const moduleKey = JSON.stringify("li_" + collectorId)
          proxy.evaluate(`delete window.__latent[${JSON.stringify(collectorId)}]; delete window.__latent[${moduleKey}]`).catch(() => {})
          runtime.injected.delete(collectorId)
          runtime.injected.delete(collectorId + ":action")
        }
      } else {
        // Enable: re-inject on all matching targets
        log.info({ collectorId }, "Collector enabled, re-injecting on matching targets")
        const def = collectors.find((c) => c.id === collectorId)
        if (!def) return
        const knownTargets = new Set<string>()
        for (const target of session.targets.values()) {
          knownTargets.add(target.targetId)
          if (!target.url.startsWith("http")) continue
          if (!matchesUrlPattern(target.url, def.urlPatterns)) continue
          const runtime = getOrCreateTargetState(state, target.targetId, target.url)
          if (hasCompleteCollectorInjection(runtime.injected, def)) continue
          scheduleCollectorCheck(state, target, collectors, db, "config-enable")
        }
        sendCommand(state.conn, "Target.getTargets")
          .then((result) => {
            const targets = (result as { targetInfos?: TargetInfo[] }).targetInfos ?? []
            for (const target of targets) {
              if (knownTargets.has(target.targetId)) continue
              if (target.type !== "page" || !target.url.startsWith("http")) continue
              if (!matchesUrlPattern(target.url, def.urlPatterns)) continue
              handleNewTarget(state, target.targetId, target.url, collectors, db, "config-enable").catch((e) => {
                if (!isStaleSessionError(e)) log.error(e, "handleNewTarget config-enable error")
              })
            }
          })
          .catch((e) => {
            if (!isStaleSessionError(e)) log.error(e, "Target.getTargets config-enable error")
          })
      }
    }
    onCollectorConfigChanged(configHandler)
    state.cleanups.push(() => offCollectorConfigChanged(configHandler))

    if (!isRunnerCurrent(state)) return false
    log.info(`Collector runner started for session: ${sessionName} (${session.targets.size} pages)`)
    return true
  } catch (e) {
    if (isStaleSessionError(e)) {
      log.debug(`Collector runner startup aborted for session: ${sessionName} (CDP disconnected)`)
      stopCollectorRunner(sessionName)
      return false
    }
    throw e
  }
}

export function stopCollectorRunner(sessionName: string): void {
  const state = runners.get(sessionName)
  if (!state) return

  state.active = false
  for (const cleanup of state.cleanups) cleanup()
  for (const targetId of state.targets.keys()) {
    clearNotifyHandlers(targetId)
  }
  const session = getSession(sessionName)
  if (session) {
    for (const targetId of session.targets.keys()) {
      clearNotifyHandlers(targetId)
    }
  }
  state.targets.clear()
  state.commandQueue.clearAll()
  runners.delete(sessionName)
  log.info(`Collector runner stopped for session: ${sessionName}`)
}

// ---------------------------------------------------------------------------
// Target handling
// ---------------------------------------------------------------------------

async function readPageActivationSnapshot(
  state: RunnerState,
  target: PageTarget,
  timeoutMs = 3000,
): Promise<PageActivationSnapshot | null> {
  try {
    const r = await sendCommand(state.conn, "Runtime.evaluate", {
      expression: `({
        hasBody: !!document.body,
        readyState: document.readyState,
        locationHref: location.href,
        visibilityState: document.visibilityState || "",
        hasFocus: document.hasFocus()
      })`,
      returnByValue: true,
    }, target.sessionId, timeoutMs) as { result: { value: unknown } }
    return isPageActiveForCollectors(r.result.value) ? r.result.value : null
  } catch {
    return null
  }
}

async function handleActivationNotification(
  state: RunnerState,
  target: PageTarget,
  collectors: CollectorDefinition[],
  db: Client,
): Promise<void> {
  const snapshot = await readPageActivationSnapshot(state, target)
  if (!snapshot) return
  const runtime = getOrCreateTargetState(state, target.targetId, snapshot.locationHref)
  updateRuntimePageActivity(runtime, snapshot)
  target.url = snapshot.locationHref
  scheduleCollectorCheck(state, target, collectors, db, "activation")
}

async function installActivationProbe(state: RunnerState, target: PageTarget): Promise<void> {
  const runtime = getOrCreateTargetState(state, target.targetId, target.url)
  const proxy = createRuntimePageProxy(state, target, runtime)
  await proxy.evaluate(`(function() {
    window.__latent = window.__latent || {};
    var probeId = ${JSON.stringify(state.activationProbeId)};

    if (window.__latent.__activationProbeId === probeId) {
      window.__latent.__activationProbeActive = true;
      return;
    }

    if (typeof window.__latent.__activationProbeCleanup === "function") {
      try { window.__latent.__activationProbeCleanup(); } catch (e) {}
    }

    window.__latent.__activationProbeId = probeId;
    window.__latent.__activationProbeActive = true;

    var notifyKey = ${JSON.stringify(ACTIVATION_NOTIFY_KEY)};
    var notifyBindingName = ${JSON.stringify(NOTIFY_BINDING_NAME)};

    function notify(reason) {
      try {
        if (!window.__latent || window.__latent.__activationProbeActive !== true) return;
        if (window.__latent.__activationProbeId !== probeId) return;
        if (typeof window[notifyBindingName] !== "function") return;

        var hasFocus = false;
        try { hasFocus = document.hasFocus(); } catch (e) {}
        var visibilityState = document.visibilityState || "";
        if (visibilityState !== "visible" && !hasFocus) return;

        window[notifyBindingName](JSON.stringify({
          key: notifyKey,
          reason: reason || "unknown",
          href: location.href,
          hasBody: !!document.body,
          readyState: document.readyState,
          visibilityState: visibilityState,
          hasFocus: hasFocus,
          detectedAt: Date.now()
        }));
      } catch (e) {}
    }

    var onVisibilityChange = function() { notify("visibilitychange"); };
    var onFocus = function() { notify("focus"); };
    var onPageShow = function() { notify("pageshow"); };

    document.addEventListener("visibilitychange", onVisibilityChange, true);
    window.addEventListener("focus", onFocus, true);
    window.addEventListener("pageshow", onPageShow, true);

    window.__latent.__activationProbeCleanup = function() {
      if (!window.__latent || window.__latent.__activationProbeId !== probeId) return;
      document.removeEventListener("visibilitychange", onVisibilityChange, true);
      window.removeEventListener("focus", onFocus, true);
      window.removeEventListener("pageshow", onPageShow, true);
      window.__latent.__activationProbeCleanup = null;
    };

    setTimeout(function() { notify("install"); }, 0);
  })()`)
  runtime.activationProbeId = state.activationProbeId
}

async function deactivateActivationProbe(state: RunnerState, target: PageTarget): Promise<void> {
  const runtime = state.targets.get(target.targetId)
  if (!runtime || runtime.activationProbeId !== state.activationProbeId) return
  runtime.activationProbeId = null
  const proxy = createRuntimePageProxy(state, target, runtime)
  try {
    await proxy.evaluate(`if (window.__latent) {
      var probeId = ${JSON.stringify(state.activationProbeId)};
      if (window.__latent.__activationProbeId === probeId) {
        window.__latent.__activationProbeActive = false;
        if (typeof window.__latent.__activationProbeCleanup === "function") {
          try { window.__latent.__activationProbeCleanup(); } catch (e) {}
        }
        window.__latent.__activationProbeCleanup = null;
        window.__latent.__activationProbeId = null;
      }
    }`)
  } catch (e) {
    if (!isStaleSessionError(e)) log.debug(e, "activation probe deactivate skipped")
  }
}

function scheduleCollectorCheck(
  state: RunnerState,
  target: PageTarget,
  collectors: CollectorDefinition[],
  db: Client,
  reason: CollectorCheckReason,
): void {
  runCollectorCheck(state, target, collectors, db, reason).catch((e) => {
    if (!isStaleSessionError(e)) log.error(e, "checkAndRunCollectors error")
  })
}

function runUrlChangePageHandlers(
  state: RunnerState,
  target: PageTarget,
  collectors: CollectorDefinition[],
  db: Client,
  runtime: TargetRuntimeState,
): void {
  const matching = getUrlChangePageHandlerCollectors(target.url, collectors, runtime.injected)
  if (matching.length === 0) return

  for (const collector of matching) {
    const proxy = createRuntimePageProxy(state, target, runtime, state.cleanups, `url-change:${collector.id}`)
    try {
      log.debug(`${ts()} URL change pageHandler "${collector.id}" on ${target.url.slice(0, 40)}`)
      collector.pageHandler!(proxy, db)
    } catch (e) {
      if (isStaleSessionError(e)) {
        log.debug(`URL change pageHandler "${collector.id}" aborted (session gone)`)
      } else {
        log.error(e, `URL change pageHandler "${collector.id}" error`)
      }
    }
  }
}

function isRunnerCurrent(state: RunnerState): boolean {
  const session = getSession(state.sessionName)
  return state.active && runners.get(state.sessionName) === state && session?.conn === state.conn
}

async function runCollectorCheck(
  state: RunnerState,
  target: PageTarget,
  collectors: CollectorDefinition[],
  db: Client,
  reason: CollectorCheckReason,
): Promise<void> {
  if (!state.active) return
  if (!target.url.startsWith("http")) return
  const runtime = getOrCreateTargetState(state, target.targetId, target.url)

  if (runtime.checking) {
    runtime.pendingCheck = reason
    return
  }

  const recordsLocationCheck = reason === "location-change" || reason === "frame-navigation"
  if (reason === "location-change") {
    const now = Date.now()
    if (isDuplicateLocationCheck(runtime.lastLocationCheck ?? undefined, target.url, now)) return
  }

  runtime.checking = true
  let completed = false
  try {
    log.debug(`${ts()} collector check (${reason}): ${target.url.slice(0, 60)}`)
    await checkAndRunCollectors(state, target, collectors, db)
    await deactivateActivationProbe(state, target)
    completed = true
  } finally {
    if (completed && recordsLocationCheck) {
      runtime.lastLocationCheck = { url: target.url, at: Date.now() }
    }
    runtime.checking = false

    const pendingReason = runtime.pendingCheck
    if (!pendingReason || !state.active) return
    runtime.pendingCheck = null

    const session = getSession(state.sessionName)
    const latestTarget = session?.targets.get(target.targetId)
    if (latestTarget) {
      await runCollectorCheck(state, latestTarget, collectors, db, pendingReason)
    }
  }
}

async function handleNewTarget(
  state: RunnerState,
  targetId: string,
  url: string,
  collectors: CollectorDefinition[],
  db: Client,
  reason: TargetAttachReason,
): Promise<void> {
  // Skip until cdpHandlers have finished
  if (!state.cdpReady) return
  if (!hasEnabledMatchingCollectors(url, collectors)) return
  const runtime = getOrCreateTargetState(state, targetId, url)
  // Skip if this target already has the lightweight probe and this is not a navigation.
  if (reason !== "location-change" && runtime.activationProbeId === state.activationProbeId) return
  if (runtime.processing) return
  runtime.processing = true

  try {
    const session = getSession(state.sessionName)
    if (!session) return

    log.debug(`${ts()} handleNewTarget: attaching ${url.slice(0, 60)}`)
    const target = await attachTarget(session, targetId, url)
    if (!target) return
    log.debug(`${ts()} handleNewTarget: attached, waiting for page readiness`)

    let pageReady = false
    let snapshot: PageActivationSnapshot | PageReadinessSnapshot | null = null
    for (let i = 0; i < 10; i++) {
      try {
        const r = await sendCommand(state.conn, "Runtime.evaluate", {
          expression: `({
            hasBody: !!document.body,
            readyState: document.readyState,
            locationHref: location.href,
            visibilityState: document.visibilityState || "",
            hasFocus: document.hasFocus()
          })`,
          returnByValue: true,
        }, target.sessionId, 3000) as { result: { value: unknown } }
        if (isPageReadyForCollectors(r.result.value)) {
          pageReady = true
          snapshot = r.result.value
          target.url = snapshot.locationHref
          runtime.url = snapshot.locationHref
          updateRuntimePageActivity(runtime, snapshot)
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
    if (!shouldRunCollectorsAfterAttach(reason, snapshot)) {
      runtime.pageActive = false
      if (hasEnabledMatchingCollectors(target.url, collectors)) {
        await installActivationProbe(state, target)
      }
      log.debug(`${ts()} handleNewTarget: page ready but inactive, deferring collectors`)
      return
    }
    const checkReason: CollectorCheckReason =
      reason === "location-change" ? "location-change" :
      reason === "config-enable" ? "config-enable" :
      "initial-visible"
    log.debug(`${ts()} handleNewTarget: page ready, scheduling collectors (${checkReason})`)

    await runCollectorCheck(state, target, collectors, db, checkReason)
    log.debug(`${ts()} handleNewTarget: done`)
  } finally {
    runtime.processing = false

    const pendingUrl = runtime.pendingUrl
    if (!pendingUrl || !state.active) return

    runtime.pendingUrl = null
    const session = getSession(state.sessionName)
    if (!session) return

    const pendingTarget = session.targets.get(targetId)
    if (pendingTarget) {
      pendingTarget.url = pendingUrl
      runtime.url = pendingUrl
      if (!pendingUrl.startsWith("http")) {
        clearTargetRuntime(state, targetId)
        return
      }
      if (!hasEnabledMatchingCollectors(pendingUrl, collectors)) {
        clearTargetRuntime(state, targetId)
        return
      }

      if (hasCompleteMatchingInjection(runtime, pendingUrl, collectors)) {
        runUrlChangePageHandlers(state, pendingTarget, collectors, db, runtime)
        return
      }

      scheduleCollectorCheck(state, pendingTarget, collectors, db, "location-change")
      return
    }

    if (!pendingUrl.startsWith("http")) return
    if (!hasEnabledMatchingCollectors(pendingUrl, collectors)) return
    handleNewTarget(state, targetId, pendingUrl, collectors, db, "location-change").catch((e) => {
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

  const runtime = getOrCreateTargetState(state, target.targetId, target.url)
  const injected = runtime.injected

  const proxy = createRuntimePageProxy(state, target, runtime, state.cleanups)

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

export function getRunnerInfo(): {
  sessionName: string
  pageCount: number
  attachedPageCount: number
  probedPageCount: number
  injectedPageCount: number
  deferredPageCount: number
}[] {
  return Array.from(runners.entries()).map(([name, state]) => {
    const session = getSession(name)
    const attachedPageCount = session?.targets.size ?? state.targets.size
    const injectedPageCount = Array.from(state.targets.values()).filter((target) => target.injected.size > 0).length
    const probedPageCount = Array.from(state.targets.values()).filter((target) => target.activationProbeId === state.activationProbeId).length
    const deferredPageCount = Array.from(state.targets.values()).filter(
      (target) => target.activationProbeId === state.activationProbeId && target.injected.size === 0,
    ).length
    return {
      sessionName: name,
      pageCount: attachedPageCount,
      attachedPageCount,
      probedPageCount,
      injectedPageCount,
      deferredPageCount,
    }
  })
}

export const __test__ = {
  decideTargetInfoChange,
  hasCompleteCollectorInjection,
  hasEnabledMatchingCollectors,
  isStaleSessionError,
  isPageReadyForCollectors,
  isPageActiveForCollectors,
  orderPageTargetsForInitialAttach,
  getUrlChangePageHandlerCollectors,
  CdpCommandQueue,
  runWithConcurrency,
  shouldRunCollectorsAfterAttach,
  parseActivationNotifyPayload,
  isDuplicateLocationCheck,
}
