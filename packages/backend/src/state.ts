/**
 * Runtime state management.
 *
 * Manages ~/.latent_info/state.json for browser sessions.
 * Session identity and user manual connect/disconnect intent are persisted;
 * runtime fields (alive, cdpPort, cdpWsUrl, attached) are computed live.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { getProfileDir, ensureProfileDir } from "./config.js"

export type ManualSessionAction = "connect" | "disconnect"

/** Persisted to state.json */
export interface StoredSession {
  sessionName: string
  pid: number
  browserName: string
  appPath: string
  profilePath: string
  startedAt: string
  /** Last user-initiated action for this session, if any. */
  lastManualAction?: ManualSessionAction
  /** ISO timestamp for lastManualAction. */
  lastManualActionAt?: string
}

/** Returned by API — extends stored with live fields */
export interface BrowserSession extends StoredSession {
  alive: boolean
  cdpPort: number | null
  cdpWsUrl: string | null
  attached: boolean
  connectionError: string | null
}

/**
 * Read the CDP debugging port from Chrome's DevToolsActivePort file.
 * Returns { port, wsUrl } or null if unavailable.
 */
export function readCdpPort(profilePath: string): { port: number; wsUrl: string } | null {
  const portFile = join(profilePath, "DevToolsActivePort")
  if (!existsSync(portFile)) return null

  try {
    const lines = readFileSync(portFile, "utf-8").trim().split("\n")
    if (lines.length < 2) return null
    const port = parseInt(lines[0]!, 10)
    if (isNaN(port)) return null
    const wsUrl = `ws://127.0.0.1:${port}${lines[1]}`
    return { port, wsUrl }
  } catch {
    return null
  }
}

/**
 * Generate a unique session name from PID and process start time.
 * Format: "s_<pid>_<epoch_base36>" — alphanumeric + underscores only,
 * safe for use as object keys, file names, and URL path segments.
 */
export function makeSessionName(pid: number, startedAt: string): string {
  const ts = Math.floor(new Date(startedAt).getTime() / 1000)
  return `s_${pid}_${ts.toString(36)}`
}

export interface AppState {
  sessions: StoredSession[]
}

function getStatePath(): string {
  return join(getProfileDir(), "state.json")
}

export function loadState(): AppState {
  ensureProfileDir()
  const statePath = getStatePath()

  if (existsSync(statePath)) {
    try {
      const raw = readFileSync(statePath, "utf-8")
      return JSON.parse(raw) as AppState
    } catch {
      // Corrupted — return fresh state
    }
  }

  return { sessions: [] }
}

export function saveState(state: AppState): void {
  const statePath = getStatePath()
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8")
}

export function getSessionManualActions(): ReadonlyMap<string, ManualSessionAction> {
  const state = loadState()
  const actions = new Map<string, ManualSessionAction>()
  for (const s of state.sessions) {
    if (s.lastManualAction) {
      actions.set(s.sessionName, s.lastManualAction)
    }
  }
  return actions
}

export function recordSessionManualAction(sessionName: string, action: ManualSessionAction): boolean {
  const state = loadState()
  const session = state.sessions.find((s) => s.sessionName === sessionName)
  if (!session) return false
  session.lastManualAction = action
  session.lastManualActionAt = new Date().toISOString()
  saveState(state)
  return true
}
