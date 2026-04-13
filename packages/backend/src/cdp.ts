/**
 * CDP (Chrome DevTools Protocol) connection manager.
 *
 * Raw WebSocket connection to Chrome's DevTools protocol.
 * No --remote-debugging-port required — reads DevToolsActivePort file.
 *
 * Provides:
 * - Browser-level session for target discovery and management
 * - Per-target sessions for page-level commands (evaluate, screenshot, etc.)
 * - Event subscription with per-session filtering
 * - Notification binding (__latentNotify)
 */

import { WebSocket } from "ws"
import { createLogger } from "./logger.js"

const log = createLogger("cdp")

/** Name of the page->backend notification binding added to every attached target */
export const NOTIFY_BINDING_NAME = "__latentInfoNotify"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CdpConnection {
  ws: WebSocket
  sessionName: string
  wsUrl: string
  nextId: number
  pending: Map<number, {
    resolve: (v: unknown) => void
    reject: (e: Error) => void
    timeout: ReturnType<typeof setTimeout>
  }>
  /** Event listeners: "method" -> Set<handler>. Handlers receive (params, sessionId?). */
  eventListeners: Map<string, Set<(params: Record<string, unknown>, sessionId?: string) => void>>
}

/** A page target we're attached to */
export interface PageTarget {
  targetId: string
  /** CDP session ID for this target (from Target.attachToTarget flatten) */
  sessionId: string
  url: string
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface CdpSession {
  sessionName: string
  wsUrl: string
  conn: CdpConnection
  /** All page targets we're attached to, keyed by targetId */
  targets: Map<string, PageTarget>
}

const sessions = new Map<string, CdpSession>()

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/** Prevents concurrent attach() calls for the same session */
const attachInProgress = new Set<string>()

export function isAttaching(sessionName: string): boolean {
  return attachInProgress.has(sessionName)
}

export function isAttached(sessionName: string): boolean {
  const s = sessions.get(sessionName)
  return s?.conn.ws.readyState === WebSocket.OPEN
}

export function getSession(sessionName: string): CdpSession | undefined {
  return sessions.get(sessionName)
}

export function attach(sessionName: string, wsUrl: string, timeoutMs = 5000, onDisconnect?: () => void): Promise<boolean> {
  // Prevent concurrent connections to the same session
  if (attachInProgress.has(sessionName)) {
    log.debug({ sessionName }, "Attach already in progress, skipping")
    return Promise.resolve(false)
  }
  attachInProgress.add(sessionName)

  return new Promise<boolean>((resolve) => {
    detach(sessionName)

    try {
      const ws = new WebSocket(wsUrl, { timeout: timeoutMs })

      const conn: CdpConnection = {
        ws, sessionName, wsUrl,
        nextId: 1,
        pending: new Map(),
        eventListeners: new Map(),
      }

      const session: CdpSession = {
        sessionName, wsUrl, conn,
        targets: new Map(),
      }

      ws.on("open", () => {
        attachInProgress.delete(sessionName)
        sessions.set(sessionName, session)
        log.info({ sessionName }, "CDP attached")
        resolve(true)
      })

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>

          // Command response
          if (typeof msg.id === "number") {
            const p = conn.pending.get(msg.id)
            if (p) {
              conn.pending.delete(msg.id)
              clearTimeout(p.timeout)
              if (msg.error) {
                p.reject(new Error(JSON.stringify(msg.error)))
              } else {
                p.resolve(msg.result)
              }
            }
            return
          }

          // Event — dispatch to listeners with sessionId for filtering
          if (typeof msg.method === "string") {
            const listeners = conn.eventListeners.get(msg.method)
            if (listeners) {
              const params = (msg.params ?? {}) as Record<string, unknown>
              const sid = msg.sessionId as string | undefined
              for (const fn of listeners) {
                try { fn(params, sid) } catch (e) {
                  log.error({ method: msg.method, err: e }, "Event handler error")
                }
              }
            }
          }
        } catch { /* ignore parse errors */ }
      })

      ws.on("error", (err) => {
        attachInProgress.delete(sessionName)
        log.warn({ sessionName, err: err.message }, "CDP WebSocket error")
        // Only delete if we're still the active session (avoid nuking a newer reconnect)
        if (sessions.get(sessionName) === session) {
          sessions.delete(sessionName)
        }
        resolve(false)
      })

      ws.on("close", (code, reason) => {
        clearPending(conn)
        // Only delete if we're still the active session.
        if (sessions.get(sessionName) === session) {
          sessions.delete(sessionName)
          onDisconnect?.()
        }
        log.warn({ sessionName, code, reason: reason?.toString() || "" }, "CDP disconnected")
      })
    } catch {
      attachInProgress.delete(sessionName)
      resolve(false)
    }
  })
}

/** Reject all pending commands and clear their timeouts. */
function clearPending(conn: CdpConnection): void {
  for (const [id, p] of conn.pending) {
    clearTimeout(p.timeout)
    p.reject(new Error("CDP session closed"))
  }
  conn.pending.clear()
}

export function detach(sessionName: string): void {
  const s = sessions.get(sessionName)
  if (!s) return
  clearPending(s.conn)
  try { s.conn.ws.close() } catch { /* already closed */ }
  sessions.delete(sessionName)
  log.info({ sessionName }, "CDP detached")
}

export function getAttachedSessions(): string[] {
  return Array.from(sessions.entries())
    .filter(([, s]) => s.conn.ws.readyState === WebSocket.OPEN)
    .map(([name]) => name)
}

// ---------------------------------------------------------------------------
// Send CDP command
// ---------------------------------------------------------------------------

export function sendCommand(
  conn: CdpConnection,
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
  timeoutMs = 30000,
): Promise<unknown> {
  if (conn.ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error(`CDP not connected`))
  }

  const id = conn.nextId++
  const msg: Record<string, unknown> = { id, method }
  if (params) msg.params = params
  if (sessionId) msg.sessionId = sessionId

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (conn.pending.has(id)) {
        conn.pending.delete(id)
        reject(new Error(`CDP command timeout: ${method}`))
      }
    }, timeoutMs)
    conn.pending.set(id, { resolve, reject, timeout })
    conn.ws.send(JSON.stringify(msg))
  })
}

// ---------------------------------------------------------------------------
// Event subscription
// ---------------------------------------------------------------------------

/**
 * Listen for a CDP event. Handler receives (params, sessionId).
 * Returns unsubscribe function.
 */
export function onEvent(
  conn: CdpConnection,
  method: string,
  handler: (params: Record<string, unknown>, sessionId?: string) => void,
): () => void {
  let listeners = conn.eventListeners.get(method)
  if (!listeners) {
    listeners = new Set()
    conn.eventListeners.set(method, listeners)
  }
  listeners.add(handler)

  return () => {
    listeners!.delete(handler)
    if (listeners!.size === 0) {
      conn.eventListeners.delete(method)
    }
  }
}

// ---------------------------------------------------------------------------
// Target management
// ---------------------------------------------------------------------------

/**
 * Attach to a page target. Enables Runtime + Page domains.
 * Returns the PageTarget or null on failure.
 */
export async function attachTarget(
  session: CdpSession,
  targetId: string,
  url: string,
): Promise<PageTarget | null> {
  if (session.targets.has(targetId)) return session.targets.get(targetId)!

  try {
    const result = await sendCommand(session.conn, "Target.attachToTarget", {
      targetId,
      flatten: true,
    }, undefined, 5000) as { sessionId: string }

    const target: PageTarget = {
      targetId,
      sessionId: result.sessionId,
      url,
    }
    session.targets.set(targetId, target)

    // Enable domains we need
    await Promise.all([
      sendCommand(session.conn, "Runtime.enable", {}, target.sessionId),
      sendCommand(session.conn, "Page.enable", {}, target.sessionId),
      sendCommand(session.conn, "Page.setLifecycleEventsEnabled", { enabled: true }, target.sessionId),
    ])

    // Add notification binding — creates window.__latentNotify(payload) on the page.
    // Survives navigations. Idempotent. Fires Runtime.bindingCalled events.
    await sendCommand(session.conn, "Runtime.addBinding", {
      name: NOTIFY_BINDING_NAME,
    }, target.sessionId)

    return target
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // "already attached" is fine — find the existing session
    if (msg.includes("already attached")) {
      return session.targets.get(targetId) ?? null
    }
    return null
  }
}

export function removeTarget(session: CdpSession, targetId: string): void {
  session.targets.delete(targetId)
}
