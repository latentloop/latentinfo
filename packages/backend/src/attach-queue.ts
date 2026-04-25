/**
 * Centralized CDP attach coordination.
 *
 * All attach/detach operations go through this queue to ensure:
 * - At most one auto-attach run is active at a time (mutex)
 * - Auto-attach runs only on browser activation events
 * - Manual detach intent is respected (auto-attach won't re-attach)
 * - Debounces rapid reconnect (2s window)
 */

import type { Client } from "@libsql/client"
import { execFileSync } from "node:child_process"
import { attach, detach, isAttached, isAttaching, getAttachedSessions } from "./cdp.js"
import { startCollectorRunner, stopCollectorRunner, type ActiveTabHint, type CollectorDefinition } from "./collector-runner.js"
import { isBrowserFrontmost, refreshSessions } from "./browser-monitor.js"
import { getSessionManualActions, recordSessionManualAction, type BrowserSession } from "./state.js"
import type { BrowserEntry } from "./settings.js"
import { loadSettings } from "./settings.js"
import { createLogger } from "./logger.js"

const log = createLogger("attach-queue")

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Mutex: only one processQueue cycle at a time. */
let processing = false

/** Stashed for processQueue to use. */
let _browsers: BrowserEntry[] = []

/** Collector definitions passed at init. */
let _collectors: CollectorDefinition[] = []

/** Database client passed at init. */
let _db: Client | null = null

/** Optional callback to trigger fast dialog polling before attach. */
let _triggerDialogBurst: (() => void) | null = null

/** Optional callback to notify when a session is attached/detached. */
let _onSessionChange: ((event: string, sessionName: string) => void) | null = null

/** Timestamp (ms) of the most recent attach attempt — used to measure dialog delay. */
let _lastAttachStartMs = 0

/** Track when each session was last detached — used to debounce rapid reconnect cycles. */
const lastDetachTime = new Map<string, number>()

/** Debounce window: if a session was detached less than this many ms ago, delay re-attach. */
const REATTACH_DEBOUNCE_MS = 2000

const BROWSER_SCRIPT_NAMES: Record<string, string> = {
  "Google Chrome.app": "Google Chrome",
  "Google Chrome Canary.app": "Google Chrome Canary",
  "Google Chrome for Testing.app": "Google Chrome for Testing",
}

/** Get ms since the last attach attempt (for dialog timing logs). */
export function getLastAttachStartMs(): number {
  return _lastAttachStartMs
}

function getBrowserScriptName(appPath: string): string {
  const appBundleName = appPath.split("/").pop() ?? appPath
  return BROWSER_SCRIPT_NAMES[appBundleName] ?? appBundleName.replace(/\.app$/, "")
}

function readActiveTabHint(appPath: string): ActiveTabHint | undefined {
  const appName = getBrowserScriptName(appPath)
  const script = `
    const app = Application(${JSON.stringify(appName)});
    if (!app.running() || app.windows.length === 0) {
      "";
    } else {
      const tab = app.windows[0].activeTab;
      JSON.stringify({ url: tab.url(), title: tab.title() });
    }
  `
  try {
    const raw = execFileSync("osascript", ["-l", "JavaScript", "-e", script], {
      encoding: "utf-8",
      timeout: 1000,
    }).trim()
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return typeof parsed.url === "string" && parsed.url.startsWith("http")
      ? {
          url: parsed.url,
          title: typeof parsed.title === "string" ? parsed.title : undefined,
        }
      : undefined
  } catch (e) {
    log.debug({ appName, error: e instanceof Error ? e.message : String(e) }, "Could not read active browser tab")
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the queue with the browser list, collectors, and database.
 * Must be called once at server startup.
 */
export function initAttachQueue(
  browsers: BrowserEntry[],
  collectors: CollectorDefinition[],
  db: Client,
  triggerDialogBurst?: () => void,
  onSessionChange?: (event: string, sessionName: string) => void,
): void {
  _browsers = browsers
  _collectors = collectors
  _db = db
  _triggerDialogBurst = triggerDialogBurst ?? null
  _onSessionChange = onSessionChange ?? null
}

/**
 * Request an auto-attach run.
 * Called by the browser monitor on launch/terminate/poll/activate events.
 * Auto-attach only runs on activation events.
 */
export function requestAutoAttach(reason: "launch" | "terminate" | "poll" | "activate"): void {
  if (reason !== "activate") {
    log.debug({ reason }, "Ignore auto-attach trigger")
    return
  }

  const settings = loadSettings()
  if (!settings.autoAttach) {
    log.debug("Ignore auto-attach: globally disabled")
    return
  }

  const candidates = refreshSessions(_browsers)
    .filter((s) => s.alive && isBrowserFrontmost(s.appPath, s.pid))
    .map((s) => s.sessionName)

  if (candidates.length === 0) {
    log.debug("Ignore activate trigger: no frontmost auto-attach candidate")
    return
  }

  processQueue(new Set(candidates)).catch((e) => log.error(e, "processQueue error"))
}

/**
 * Manual attach from the API. Bypasses queue — runs immediately.
 * Clears any auto-attach blockers for this session.
 */
export async function requestManualAttach(sessionName: string, wsUrl: string): Promise<boolean> {
  if (!recordSessionManualAction(sessionName, "connect")) {
    log.debug({ sessionName }, "Manual attach action not persisted (session missing)")
  }

  log.info({ sessionName }, "Manual attach requested")
  _triggerDialogBurst?.()
  _lastAttachStartMs = Date.now()
  const ok = await attach(sessionName, wsUrl, 5000, () => _onSessionChange?.("session-disconnected", sessionName))
  const attachMs = Date.now() - _lastAttachStartMs
  if (ok) {
    _onSessionChange?.("session-attached", sessionName)
    log.info({ sessionName, attachMs }, "Manual attach succeeded")
    if (_db) {
      const session = refreshSessions(_browsers).find((s) => s.sessionName === sessionName)
      await startCollectorRunner(sessionName, _collectors, _db, session ? readActiveTabHint(session.appPath) : undefined)
    }
    _onSessionChange?.("session-ready", sessionName)
  } else {
    log.warn({ sessionName, attachMs }, "Manual attach failed")
  }
  return ok
}

/**
 * Manual detach from the API.
 * Marks session so auto-attach won't re-attach.
 */
export function requestManualDetach(sessionName: string): void {
  if (!recordSessionManualAction(sessionName, "disconnect")) {
    log.debug({ sessionName }, "Manual detach action not persisted (session missing)")
  }
  stopCollectorRunner(sessionName)
  lastDetachTime.set(sessionName, Date.now())
  detach(sessionName)
  _onSessionChange?.("session-detached", sessionName)
  log.info({ sessionName }, "Manual detach")
}

// ---------------------------------------------------------------------------
// Internal: the single processing loop
// ---------------------------------------------------------------------------

async function processQueue(targetSessions?: ReadonlySet<string>): Promise<void> {
  if (processing) {
    log.debug("Skip auto-attach: previous run still in progress")
    return
  }
  processing = true

  try {
    const sessions = refreshSessions(_browsers)
    const manualActions = getSessionManualActions()

    for (const session of sessions) {
      const sn = session.sessionName
      if (targetSessions && !targetSessions.has(sn)) continue
      if (!session.alive) continue

      // Resolve CDP WebSocket URL — request remote debugging if needed
      let wsUrl = session.cdpWsUrl
      if (!wsUrl) {
        log.info({ sn, browser: session.browserName }, "No CDP port, requesting remote debugging")
        try {
          execFileSync("open", ["-a", session.appPath, "--args", "--remote-debugging-port=0"], { timeout: 5000 })
        } catch (e) {
          log.warn({ sn, error: String(e) }, "Failed to request remote debugging")
        }
        _triggerDialogBurst?.()
        await new Promise((r) => setTimeout(r, 3000))
        // Re-read sessions to pick up the new CDP port
        const updated = refreshSessions(_browsers).find((s) => s.sessionName === sn)
        if (!updated?.cdpWsUrl) {
          log.debug({ sn }, "Still no CDP port after requesting debugging")
          continue
        }
        wsUrl = updated.cdpWsUrl
      }
      if (isAttached(sn)) continue
      if (isAttaching(sn)) { log.debug({ sn }, "Skip: attach in progress"); continue }
      if (manualActions.get(sn) === "disconnect") {
        log.debug({ sn }, "Skip: last manual action is disconnect")
        continue
      }

      log.info({ sn, browser: session.browserName }, "Auto-attaching")

      // Debounce: if this session was just detached, wait before re-attaching
      const lastDetach = lastDetachTime.get(sn)
      if (lastDetach) {
        const elapsed = Date.now() - lastDetach
        if (elapsed < REATTACH_DEBOUNCE_MS) {
          const wait = REATTACH_DEBOUNCE_MS - elapsed
          log.debug({ sn, wait }, "Debouncing re-attach")
          await new Promise((r) => setTimeout(r, wait))
        }
        lastDetachTime.delete(sn)
      }

      // Chrome 136+ shows the "Allow remote debugging?" dialog only AFTER
      // something attempts to connect to the CDP port. Strategy:
      // 1. Trigger dialog burst (start fast 100ms polling for the dialog)
      // 2. First attach attempt — triggers the dialog if it hasn't appeared
      // 3. If it fails (403), wait for Swift to dismiss the dialog, then retry
      _triggerDialogBurst?.()
      _lastAttachStartMs = Date.now()

      try {
        const onDisconnect = () => _onSessionChange?.("session-disconnected", sn)
        let ok = await attach(sn, wsUrl, 5000, onDisconnect)

        // First attempt likely fails with 403 (dialog just appeared).
        // Wait for Swift to dismiss it (burst polling at 100ms), then retry.
        if (!ok) {
          log.debug({ sn }, "Auto-attach retry — waiting for dialog dismissal")
          _triggerDialogBurst?.()
          await new Promise((r) => setTimeout(r, 2000))
          ok = await attach(sn, wsUrl, 5000, onDisconnect)
        }

        const attachMs = Date.now() - _lastAttachStartMs
        if (ok) {
          _onSessionChange?.("session-attached", sn)
          log.info({ sn, attachMs }, "Auto-attached successfully")
          if (_db) {
            await startCollectorRunner(sn, _collectors, _db, readActiveTabHint(session.appPath))
          }
          _onSessionChange?.("session-ready", sn)
        } else {
          log.warn({ sn, attachMs }, "Auto-attach failed")
        }
      } catch (e) {
        log.error(e, `Auto-attach error (${sn})`)
      }
    }
  } finally {
    processing = false
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Auto-attach eligibility is controlled by the global settings.autoAttach flag
// (checked in requestAutoAttach). No per-browser flag needed.

/**
 * Disconnect all CDP sessions and stop all collector runners.
 * Called when the user disables auto-attach globally.
 */
export function globalDisableAll(): void {
  const now = Date.now()
  for (const sessionName of getAttachedSessions()) {
    stopCollectorRunner(sessionName)
    lastDetachTime.set(sessionName, now)
    detach(sessionName)
  }
  log.info("All sessions disconnected (global disable)")
}
