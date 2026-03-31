/**
 * Browser process monitor.
 *
 * Scans for running Chrome processes and monitors for new launches
 * using macOS NSWorkspace notifications via a Swift helper process.
 *
 * Also handles automatic dismissal of Chrome's "Allow remote debugging?"
 * dialog via AX API polling within the same Swift process. This is
 * controlled by the `remoteDebuggingAutoAllow` setting — Node sends
 * "DIALOG_AUTO_ALLOW:on" / "DIALOG_AUTO_ALLOW:off" via stdin.
 */

import { execSync, spawn, type ChildProcess } from "node:child_process"
import type { BrowserEntry } from "./settings.js"
import { loadState, saveState, makeSessionName, readCdpPort, type BrowserSession, type StoredSession } from "./state.js"
import { isAttached } from "./cdp.js"
import { getLastAttachStartMs } from "./attach-queue.js"
import { createLogger } from "./logger.js"

const log = createLogger("monitor")

/** Map of app binary names to match in process list */
const APP_BINARY_MAP: Record<string, string> = {
  "Google Chrome.app": "Google Chrome",
  "Google Chrome Canary.app": "Google Chrome Canary",
  "Google Chrome for Testing.app": "Google Chrome for Testing",
}

/** Current frontmost browser app path (or null if none/unknown). */
let frontmostBrowserAppPath: string | null = null

/** Current frontmost browser app PID (or null if none/unknown). */
let frontmostBrowserPid: number | null = null

/** Map localized macOS app name -> configured browser app path. */
let appNameToPath = new Map<string, string>()

/** True when we can reliably track app activation via NSWorkspace. */
let enforceFrontmostCheck = false

interface ProcessInfo {
  pid: number
  startedAt: string
  command: string
}

/**
 * Parse `ps` output to find Chrome main processes.
 * Uses -o to get pid, lstart (full start time), and command.
 */
function scanRunningBrowsers(): ProcessInfo[] {
  try {
    // Get all processes with their start time
    const raw = execSync(
      `ps -eo pid=,lstart=,command= | grep -i "Google Chrome" | grep -v grep | grep -v Helper`,
      { encoding: "utf-8", timeout: 5000 },
    )

    const processes: ProcessInfo[] = []
    for (const line of raw.trim().split("\n")) {
      if (!line.trim()) continue

      // Format: "  PID  DAY MON DD HH:MM:SS YYYY  COMMAND..."
      const match = line.trim().match(
        /^(\d+)\s+\w+\s+(\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/,
      )
      if (!match) continue

      const pid = parseInt(match[1]!, 10)
      const dateStr = match[2]!
      const command = match[3]!

      // Only match the main browser process (contains .app/Contents/MacOS/)
      if (!command.includes(".app/Contents/MacOS/")) continue

      let startedAt: string
      try {
        const parsed = new Date(dateStr)
        startedAt = Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString()
      } catch {
        startedAt = new Date().toISOString()
      }

      processes.push({ pid, startedAt, command })
    }

    return processes
  } catch {
    return []
  }
}

/** Match a process command to a known browser entry */
function matchBrowser(
  command: string,
  browsers: BrowserEntry[],
): BrowserEntry | undefined {
  for (const browser of browsers) {
    const appName = browser.appPath.split("/").pop()!
    const binaryName = APP_BINARY_MAP[appName]
    if (binaryName && command.includes(appName)) {
      return browser
    }
  }
  return undefined
}

function getAppNameFromPath(appPath: string): string | null {
  const appBundleName = appPath.split("/").pop()!
  return APP_BINARY_MAP[appBundleName] ?? null
}

function clearFrontmostBrowser(): void {
  frontmostBrowserAppPath = null
  frontmostBrowserPid = null
}

function setFrontmostApp(appName: string | null, pid: number | null): void {
  if (!appName) {
    clearFrontmostBrowser()
    return
  }
  const appPath = appNameToPath.get(appName)
  if (!appPath) {
    clearFrontmostBrowser()
    return
  }
  frontmostBrowserAppPath = appPath
  frontmostBrowserPid = typeof pid === "number" && Number.isFinite(pid) && pid > 0 ? pid : null
}

export function isBrowserFrontmost(appPath: string, pid: number): boolean {
  if (!enforceFrontmostCheck) return true
  if (frontmostBrowserPid !== null) return frontmostBrowserPid === pid
  return frontmostBrowserAppPath === appPath
}

/** Check if a PID is still running */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Refresh sessions: scan for running browsers, update alive status,
 * add newly discovered processes, persist to state.json.
 */
export function refreshSessions(browsers: BrowserEntry[]): BrowserSession[] {
  const state = loadState()
  const running = scanRunningBrowsers()

  // Remove dead sessions
  state.sessions = state.sessions.filter((s) => isProcessAlive(s.pid))

  // Add new processes not already tracked
  const trackedPids = new Set(state.sessions.map((s) => s.pid))
  for (const proc of running) {
    if (trackedPids.has(proc.pid)) continue

    const browser = matchBrowser(proc.command, browsers)
    if (!browser) continue

    state.sessions.push({
      sessionName: makeSessionName(proc.pid, proc.startedAt),
      pid: proc.pid,
      browserName: browser.name,
      appPath: browser.appPath,
      profilePath: browser.profilePath,
      startedAt: proc.startedAt,
    })
  }

  // Persist only static session data
  saveState(state)

  // Compute live fields for API response
  return state.sessions.map((s): BrowserSession => {
    const cdp = readCdpPort(s.profilePath)
    const hasCdp = !!cdp
    return {
      ...s,
      alive: true,
      cdpPort: cdp?.port ?? null,
      cdpWsUrl: cdp?.wsUrl ?? null,
      attached: isAttached(s.sessionName),
      connectionError: !hasCdp
        ? `Cannot connect to ${s.sessionName}: no remote debugging port detected. Check chrome://inspect or relaunch the browser with remote debugging allowed.`
        : null,
    }
  })
}

/**
 * Start monitoring for browser process launches using macOS
 * NSWorkspace.didLaunchApplicationNotification via a Swift script.
 *
 * Falls back to polling if Swift is unavailable.
 */
export type MonitorEventType = "launch" | "terminate" | "poll" | "activate" | "dialog_dismissed"

export function startBrowserMonitor(
  browsers: BrowserEntry[],
  onUpdate: (event: MonitorEventType) => void,
): { stop: () => void; setDialogAutoAllow: (enabled: boolean) => void; triggerDialogBurst: () => void } {
  let child: ChildProcess | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null

  // Browser names for dialog detection (e.g. "Google Chrome", "Google Chrome Canary")
  const browserProcessNames = browsers
    .map((b) => b.appPath.split("/").pop()?.replace(/\.app$/, ""))
    .filter((n): n is string => Boolean(n))
  const namesArrayLiteral = browserProcessNames.map((n) => `"${n}"`).join(", ")

  // The Swift script monitors app launches via NSWorkspace AND
  // auto-dismisses Chrome's "Allow remote debugging?" dialog using
  // the AX (Accessibility) API directly — no NSAppleScript/System Events.
  // Node controls via stdin: DIALOG_AUTO_ALLOW:on/off, DIALOG_CHECK_BURST
  const swiftCode = `
import Cocoa
import Foundation

let browserNames: [String] = [${namesArrayLiteral}]
var dialogAutoAllow = false
var dialogCheckRunning = false

func emit(_ kind: String, _ app: NSRunningApplication?) {
  guard let app, let name = app.localizedName else { return }
  print("\\(kind):\\(app.processIdentifier):\\(name)")
  fflush(stdout)
}

// ---------------------------------------------------------------------------
// Dialog dismissal via AX (Accessibility) API — direct, no System Events
// ---------------------------------------------------------------------------

func axAttr(_ el: AXUIElement, _ attr: String) -> AnyObject? {
  var val: AnyObject?
  AXUIElementCopyAttributeValue(el, attr as CFString, &val)
  return val
}

/// Find and dismiss Chrome's "Allow remote debugging?" sheet.
/// Uses structural matching (AXSheet with 3 buttons, click the last one)
/// so it works regardless of Chrome's UI language.
func findAndDismissDialog(pid: pid_t) -> Bool {
  let app = AXUIElementCreateApplication(pid)
  guard let windows = axAttr(app, "AXWindows") as? [AXUIElement] else { return false }

  for win in windows {
    guard let children = axAttr(win, "AXChildren") as? [AXUIElement] else { continue }
    for child in children {
      if (axAttr(child, "AXRole") as? String) != "AXSheet" { continue }

      // Collect all buttons in this sheet via BFS
      var buttons: [AXUIElement] = []
      var queue: [AXUIElement] = [child]
      while !queue.isEmpty {
        let el = queue.removeFirst()
        if (axAttr(el, "AXRole") as? String) == "AXButton" {
          buttons.append(el)
        }
        if let kids = axAttr(el, "AXChildren") as? [AXUIElement] {
          queue.append(contentsOf: kids)
        }
      }

      // The remote-debugging sheet has exactly 3 buttons:
      // [settings] [cancel] [allow] — the confirm action is always last.
      guard buttons.count == 3 else { continue }
      AXUIElementPerformAction(buttons[2], "AXPress" as CFString)
      return true
    }
  }
  return false
}

var axErrorReported = false

// Main dismissal function — called by burst timer and idle timer.
// Runs on the main thread. dialogCheckRunning guards against re-entrant calls.
func checkAndDismissDialogs() {
  guard dialogAutoAllow, !dialogCheckRunning else { return }
  dialogCheckRunning = true
  defer { dialogCheckRunning = false }

  // Check AX permission once
  if !axErrorReported && !AXIsProcessTrusted() {
    print("AX_PERMISSION_ERROR:Process is not trusted for accessibility. Grant permission in System Settings > Privacy & Security > Accessibility.")
    fflush(stdout)
    axErrorReported = true
    return
  }

  for name in browserNames {
    guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.localizedName == name }),
          app.processIdentifier > 0 else { continue }

    if findAndDismissDialog(pid: app.processIdentifier) {
      print("DIALOG_DISMISSED:\\(app.processIdentifier):\\(name)")
      fflush(stdout)
      burstRemaining = 0
      break
    }
  }
}

// ---------------------------------------------------------------------------
// Two-speed polling: burst (100ms) + idle (3s)
// ---------------------------------------------------------------------------

var burstRemaining = 0

Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { _ in
  if burstRemaining <= 0 { checkAndDismissDialogs() }
}

Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
  guard burstRemaining > 0 else { return }
  burstRemaining -= 1
  checkAndDismissDialogs()
}

// ---------------------------------------------------------------------------
// Read stdin for control commands
// ---------------------------------------------------------------------------

DispatchQueue.global(qos: .utility).async {
  while let line = readLine() {
    if line == "DIALOG_AUTO_ALLOW:on" {
      dialogAutoAllow = true
    } else if line == "DIALOG_AUTO_ALLOW:off" {
      dialogAutoAllow = false
      burstRemaining = 0
    } else if line == "DIALOG_CHECK_BURST" {
      burstRemaining = 100
      DispatchQueue.main.async { checkAndDismissDialogs() }
    }
  }
}

// ---------------------------------------------------------------------------
// NSWorkspace browser monitoring
// ---------------------------------------------------------------------------

emit("FRONTMOST", NSWorkspace.shared.frontmostApplication)

let center = NSWorkspace.shared.notificationCenter
center.addObserver(
  forName: NSWorkspace.didLaunchApplicationNotification,
  object: nil,
  queue: .main
) { notification in
  emit("LAUNCH", notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)
}

center.addObserver(
  forName: NSWorkspace.didTerminateApplicationNotification,
  object: nil,
  queue: .main
) { notification in
  emit("TERMINATE", notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)
}

center.addObserver(
  forName: NSWorkspace.didActivateApplicationNotification,
  object: nil,
  queue: .main
) { notification in
  emit("ACTIVATE", notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)
}

center.addObserver(
  forName: NSWorkspace.didDeactivateApplicationNotification,
  object: nil,
  queue: .main
) { notification in
  emit("DEACTIVATE", notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)
}

RunLoop.main.run()
`

  appNameToPath = new Map(
    browsers.map((b) => [getAppNameFromPath(b.appPath), b.appPath] as const)
      .filter((entry): entry is [string, string] => Boolean(entry[0])),
  )
  const browserNames = new Set(appNameToPath.keys())
  clearFrontmostBrowser()
  enforceFrontmostCheck = false

  /** Send a command to the Swift process via stdin. */
  function sendToSwift(msg: string): void {
    if (child?.stdin?.writable) {
      child.stdin.write(msg + "\n")
    }
  }

  try {
    child = spawn("swift", ["-e", swiftCode], {
      stdio: ["pipe", "pipe", "ignore"],
    })
    enforceFrontmostCheck = true

    child.stdout?.setEncoding("utf-8")
    child.stdout?.on("data", (data: string) => {
      for (const line of data.trim().split("\n")) {
        // Handle accessibility permission error (format: "AX_PERMISSION_ERROR:message")
        if (line.startsWith("AX_PERMISSION_ERROR:")) {
          const msg = line.slice("AX_PERMISSION_ERROR:".length)
          log.error(
            { error: msg },
            "Dialog auto-dismiss requires Accessibility permission. " +
            "Grant it in System Settings > Privacy & Security > Accessibility.",
          )
          continue
        }

        const parts = line.split(":")
        if (parts.length < 3) continue
        const event = parts[0]
        const pid = Number.parseInt(parts[1] ?? "", 10)
        const appName = parts.slice(2).join(":")
        const parsedPid = Number.isFinite(pid) && pid > 0 ? pid : null

        if (event === "DIALOG_DISMISSED") {
          const attachStart = getLastAttachStartMs()
          const delayMs = attachStart > 0 ? Date.now() - attachStart : null
          log.info(
            { pid: parsedPid, browser: appName, sinceAttachMs: delayMs },
            "Auto-dismissed Chrome remote debugging dialog",
          )
          onUpdate("dialog_dismissed")
          continue
        }

        if (event === "ACTIVATE" || event === "FRONTMOST") {
          setFrontmostApp(appName || null, parsedPid)
        } else if (event === "DEACTIVATE") {
          if (parsedPid !== null && frontmostBrowserPid === parsedPid) {
            clearFrontmostBrowser()
          } else if (appNameToPath.get(appName) === frontmostBrowserAppPath) {
            clearFrontmostBrowser()
          }
        }

        if (browserNames.has(appName) && (event === "LAUNCH" || event === "TERMINATE")) {
          refreshSessions(browsers)
          onUpdate(event === "LAUNCH" ? "launch" : "terminate")
        } else if (browserNames.has(appName) && (event === "ACTIVATE" || event === "FRONTMOST")) {
          refreshSessions(browsers)
          onUpdate("activate")
        }
      }
    })

    child.on("error", () => {
      // Swift unavailable, fall back to polling
      enforceFrontmostCheck = false
      log.debug("Swift monitor unavailable, using polling")
      startPolling()
    })

    child.on("exit", () => {
      child = null
      // Restart polling if the Swift process dies unexpectedly
      if (!pollTimer) {
        enforceFrontmostCheck = false
        startPolling()
      }
    })

    log.debug("Browser monitor started (NSWorkspace + dialog monitor)")
  } catch {
    startPolling()
  }

  function startPolling() {
    if (pollTimer) return
    pollTimer = setInterval(() => {
      refreshSessions(browsers)
      onUpdate("poll")
    }, 30000)
    log.debug("Browser monitor started (polling 30s)")
  }

  return {
    stop() {
      if (child) {
        child.kill()
        child = null
      }
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
      enforceFrontmostCheck = false
      clearFrontmostBrowser()
    },
    /** Enable/disable the dialog auto-dismiss in the Swift process. */
    setDialogAutoAllow(enabled: boolean) {
      sendToSwift(`DIALOG_AUTO_ALLOW:${enabled ? "on" : "off"}`)
      log.info({ enabled }, "Dialog auto-allow updated")
    },
    /** Start fast 200ms polling for ~10s (call before each attach attempt). */
    triggerDialogBurst() {
      log.debug("Dialog burst triggered")
      sendToSwift("DIALOG_CHECK_BURST")
    },
  }
}
