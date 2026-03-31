/**
 * Job runner — registers and executes statically-defined jobs.
 *
 * Jobs are imported from backend/src/jobs/ like collectors.
 * Job data files (prompt.md etc.) live at ~/.latent_info/jobs/<id>/.
 */

import { existsSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { EventEmitter } from "node:events"
import type { Client } from "@libsql/client"
import type { JobDefinition } from "./jobs/types.js"
import { getProfileDir } from "./config.js"
import { createLogger } from "./logger.js"
import { invalidateCache as invalidateVisualizerCache } from "./visualizers/x/cache.js"

const log = createLogger("job-runner")

const thisDir = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Types (internal)
// ---------------------------------------------------------------------------

interface RegisteredJob {
  def: JobDefinition
  jobDir: string
  timers: ReturnType<typeof setInterval>[]
  eventHandlers: Array<{ event: string; fn: (payload?: unknown) => void | Promise<void> }>
  scheduleFns: Array<() => void | Promise<void>>
  eventFns: Array<(payload?: unknown) => void | Promise<void>>
  /** Pending event payloads queued while the job is draining. Keyed by a dedup string (e.g. clipId). */
  pendingPayloads: Map<string, unknown>
  /** True while the drain loop is running — new events are queued instead of starting a new run. */
  draining: boolean
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const registeredJobs = new Map<string, RegisteredJob>()
const eventBus = new EventEmitter()
let _db: Client | null = null

// ---------------------------------------------------------------------------
// Run recording
// ---------------------------------------------------------------------------

function generateRunId(jobId: string): string {
  return `${jobId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
}

async function recordRunStart(db: Client, runId: string, jobId: string, trigger: string): Promise<void> {
  await db.execute({
    sql: "INSERT INTO job_runs (id, job_id, trigger, status, started_at) VALUES (?, ?, ?, 'running', ?)",
    args: [runId, jobId, trigger, new Date().toISOString()],
  })
  try { eventBus.emit("job:run-started", { jobId }) } catch { /* listener error must not break recording */ }
}

async function recordRunEnd(db: Client, runId: string, status: "success" | "error", error?: string, result?: string): Promise<void> {
  await db.execute({
    sql: "UPDATE job_runs SET status = ?, finished_at = ?, error = ?, result = ? WHERE id = ?",
    args: [status, new Date().toISOString(), error ?? null, result ?? null, runId],
  })
  try { eventBus.emit("job:run-completed", { jobId: runId.split(":")[0] }) } catch { /* listener error must not break recording */ }
}

/** Record a fully completed run in one shot (for ctx.recordRun). */
async function recordCompletedRun(
  db: Client,
  jobId: string,
  trigger: string,
  result: Record<string, unknown>,
): Promise<string> {
  const runId = generateRunId(jobId)
  const now = new Date().toISOString()
  await db.execute({
    sql: "INSERT INTO job_runs (id, job_id, trigger, status, started_at, finished_at, result) VALUES (?, ?, ?, 'success', ?, ?, ?)",
    args: [runId, jobId, trigger, now, now, JSON.stringify(result)],
  })
  try { eventBus.emit("job:run-completed", { jobId }) } catch { /* listener error must not break recording */ }
  return runId
}

/** Record an error run in one shot (for job-runner error handling). */
async function recordErrorRun(
  db: Client,
  jobId: string,
  trigger: string,
  error: string,
): Promise<string> {
  const runId = generateRunId(jobId)
  const now = new Date().toISOString()
  await db.execute({
    sql: "INSERT INTO job_runs (id, job_id, trigger, status, started_at, finished_at, error) VALUES (?, ?, ?, 'error', ?, ?, ?)",
    args: [runId, jobId, trigger, now, now, error],
  })
  try { eventBus.emit("job:run-completed", { jobId }) } catch { /* listener error must not break recording */ }
  return runId
}

/** Auto-recording wrapper for legacy schedule/event handlers without run(). */
async function executeJobFn(
  db: Client,
  jobId: string,
  trigger: string,
  fn: () => unknown | Promise<unknown>,
): Promise<{ runId: string; result?: Record<string, unknown> }> {
  const runId = generateRunId(jobId)
  let result: Record<string, unknown> | undefined
  try {
    await recordRunStart(db, runId, jobId, trigger)
    const ret = await fn()
    if (ret && typeof ret === "object") {
      result = ret as Record<string, unknown>
    }
    await recordRunEnd(db, runId, "success", undefined, result ? JSON.stringify(result) : undefined)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    log.error({ jobId, trigger, error: msg }, "Job execution failed")
    try {
      await recordRunEnd(db, runId, "error", msg)
    } catch {
      log.error({ runId }, "Failed to record job error")
    }
  }
  return { runId, result }
}

/**
 * Run a job's run() method. The job controls its own recording via ctx.recordRun().
 * The runner only records errors (when run() throws).
 */
async function runJobWithContext(
  db: Client,
  def: JobDefinition,
  ctx: import("./jobs/types.js").JobContext,
  trigger: string,
): Promise<void> {
  try {
    await def.run!(ctx)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    log.error({ jobId: def.id, trigger, error: msg }, "Job run() failed")
    try {
      await recordErrorRun(db, def.id, trigger, msg)
    } catch {
      log.error({ jobId: def.id }, "Failed to record job error")
    }
  }
}

// ---------------------------------------------------------------------------
// Seed job data files to profile directory
// ---------------------------------------------------------------------------

export function seedJobData(jobs: JobDefinition[]): void {
  for (const job of jobs) {
    if (!job.dataFiles || job.dataFiles.length === 0) continue

    const profileJobDir = join(getProfileDir(), "jobs", job.id)
    mkdirSync(profileJobDir, { recursive: true })

    // Source dir: adjacent to the compiled job.ts (same directory structure)
    const sourceDir = join(thisDir, "jobs", job.id)

    for (const file of job.dataFiles) {
      const destPath = join(profileJobDir, file)
      if (existsSync(destPath)) continue // Don't overwrite existing data

      const srcPath = join(sourceDir, file)
      if (existsSync(srcPath)) {
        cpSync(srcPath, destPath)
        log.info({ jobId: job.id, file }, "Seeded job data file")
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Start / Stop
// ---------------------------------------------------------------------------

export async function startJobRunner(db: Client, jobs: JobDefinition[]): Promise<void> {
  _db = db

  if (jobs.length === 0) {
    log.info("No jobs registered")
    return
  }

  for (const def of jobs) {
    const jobDir = join(getProfileDir(), "jobs", def.id)
    const jobLog = createLogger(`job:${def.id}`)
    const registered: RegisteredJob = {
      def,
      jobDir,
      timers: [],
      eventHandlers: [],
      scheduleFns: [],
      eventFns: [],
      pendingPayloads: new Map(),
      draining: false,
    }

    // Track the current trigger for recordRun context
    let currentTrigger = "unknown"

    const ctx: import("./jobs/types.js").JobContext = {
      db,
      jobDir,
      log: jobLog,

      schedule(intervalMs: number, fn: () => void | Promise<void>) {
        registered.scheduleFns.push(fn)
        const timer = setInterval(() => {
          if (def.run) {
            currentTrigger = "schedule"
            ctx.trigger = "schedule"
            ctx.params = undefined
            runJobWithContext(db, def, ctx, "schedule")
          } else {
            executeJobFn(db, def.id, "schedule", fn)
          }
        }, intervalMs)
        registered.timers.push(timer)
        log.info({ jobId: def.id, intervalMs }, "Registered schedule trigger")
      },

      on(event: string, fn: (payload?: unknown) => void | Promise<void>) {
        registered.eventFns.push(fn)
        const handler = (payload?: unknown) => {
          // Check event_enabled in config — only run if explicitly enabled
          let eventEnabled = false
          try {
            const cfgPath = join(registered.jobDir, "config.json")
            if (existsSync(cfgPath)) {
              const cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as Record<string, unknown>
              if (cfg.event_enabled === true) eventEnabled = true
            }
          } catch { /* malformed config → default disabled */ }
          if (!eventEnabled) {
            log.debug({ jobId: def.id, event }, "Event trigger disabled, skipping")
            return
          }

          if (def.run) {
            // Extract dedup key from payload (e.g. clipId, docId) or use a timestamp
            const p = payload && typeof payload === "object" ? payload as Record<string, unknown> : {}
            const dedupKey = String(p.clipId ?? p.docId ?? p.id ?? Date.now())
            registered.pendingPayloads.set(dedupKey, payload)

            if (registered.draining) {
              log.debug({ jobId: def.id, event, dedupKey, pending: registered.pendingPayloads.size }, "Queued (job draining)")
              return
            }

            // Start drain loop
            registered.draining = true
            void (async () => {
              try {
                while (registered.pendingPayloads.size > 0) {
                  // Snapshot and clear — new arrivals go into fresh pending map
                  const batch = [...registered.pendingPayloads.entries()]
                  registered.pendingPayloads.clear()

                  for (const [key, batchPayload] of batch) {
                    currentTrigger = event
                    ctx.trigger = event
                    ctx.params = batchPayload && typeof batchPayload === "object" ? batchPayload as Record<string, unknown> : undefined
                    log.debug({ jobId: def.id, event, dedupKey: key }, "Processing queued item")
                    await runJobWithContext(db, def, ctx, event)
                  }
                }
              } finally {
                registered.draining = false
              }
            })()
          } else {
            executeJobFn(db, def.id, event, () => fn(payload))
          }
        }
        registered.eventHandlers.push({ event, fn: handler })
        eventBus.on(event, handler)
        log.info({ jobId: def.id, event }, "Registered event trigger")
      },

      triggerRun() {
        if (def.run) {
          currentTrigger = "self"
          ctx.trigger = "self"
          ctx.params = undefined
          runJobWithContext(db, def, ctx, "self")
        }
      },

      async recordRun(result: Record<string, unknown>) {
        return recordCompletedRun(db, def.id, currentTrigger, result)
      },

      invalidateCache() {
        invalidateVisualizerCache()
      },
    }

    try {
      await def.register(ctx)
      registeredJobs.set(def.id, registered)
      log.info({ jobId: def.id }, "Job registered")
    } catch (e: unknown) {
      log.error({ jobId: def.id, error: e instanceof Error ? e.message : String(e) }, "Job registration failed")
    }
  }

  log.info(`Job runner started with ${registeredJobs.size} job(s)`)
}

export function stopJobRunner(): void {
  for (const [jobId, job] of registeredJobs) {
    for (const timer of job.timers) clearInterval(timer)
    for (const { event, fn } of job.eventHandlers) eventBus.off(event, fn)
    log.info({ jobId }, "Job stopped")
  }
  registeredJobs.clear()
  log.info("Job runner stopped")
}

// ---------------------------------------------------------------------------
// Event emission (for other backend modules)
// ---------------------------------------------------------------------------

export function emitJobEvent(event: string, payload?: unknown): void {
  eventBus.emit(event, payload)
}

export function onJobEvent(event: string, handler: (payload?: unknown) => void): () => void {
  eventBus.on(event, handler)
  return () => { eventBus.off(event, handler) }
}

// ---------------------------------------------------------------------------
// Info / queries (for API endpoints)
// ---------------------------------------------------------------------------

export interface JobInfo {
  id: string
  description: string
  triggers: {
    schedule?: number[]
    events?: string[]
  }
  config: Record<string, unknown>
  eventEnabled: boolean
  promptPath: string | null
  lastRun?: {
    id: string
    status: string
    trigger: string
    startedAt: string
    finishedAt: string | null
    error: string | null
    result: Record<string, unknown> | null
  }
  lastManualRun?: {
    id: string
    status: string
    startedAt: string
    finishedAt: string | null
    error: string | null
    result: Record<string, unknown> | null
  }
}

export async function getJobsInfo(db: Client): Promise<JobInfo[]> {
  const jobs: JobInfo[] = []

  for (const [, registered] of registeredJobs) {
    const { def, eventHandlers } = registered
    const events = eventHandlers.map((h) => h.event)

    let lastRun: JobInfo["lastRun"] = undefined
    try {
      const queryResult = await db.execute({
        sql: "SELECT id, status, trigger, started_at, finished_at, error, result FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT 1",
        args: [def.id],
      })
      if (queryResult.rows.length > 0) {
        const row = queryResult.rows[0]!
        let parsedResult: Record<string, unknown> | null = null
        if (row.result) {
          try { parsedResult = JSON.parse(String(row.result)) } catch { /* ignore */ }
        }
        lastRun = {
          id: String(row.id),
          status: String(row.status),
          trigger: String(row.trigger),
          startedAt: String(row.started_at),
          finishedAt: row.finished_at ? String(row.finished_at) : null,
          error: row.error ? String(row.error) : null,
          result: parsedResult,
        }
      }
    } catch (e) {
      log.warn({ jobId: def.id, error: e instanceof Error ? e.message : String(e) }, "Failed to query last run")
    }

    // Query last manual run
    let lastManualRun: JobInfo["lastManualRun"] = undefined
    try {
      const manualResult = await db.execute({
        sql: "SELECT id, status, started_at, finished_at, error, result FROM job_runs WHERE job_id = ? AND trigger = 'manual' ORDER BY started_at DESC LIMIT 1",
        args: [def.id],
      })
      if (manualResult.rows.length > 0) {
        const row = manualResult.rows[0]!
        let parsedResult: Record<string, unknown> | null = null
        if (row.result) {
          try { parsedResult = JSON.parse(String(row.result)) } catch { /* ignore */ }
        }
        lastManualRun = {
          id: String(row.id),
          status: String(row.status),
          startedAt: String(row.started_at),
          finishedAt: row.finished_at ? String(row.finished_at) : null,
          error: row.error ? String(row.error) : null,
          result: parsedResult,
        }
      }
    } catch { /* ignore */ }

    // Load config.json from job directory
    let config: Record<string, unknown> = {}
    const configPath = join(registered.jobDir, "config.json")
    if (existsSync(configPath)) {
      try { config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown> } catch { /* ignore */ }
    }

    // Check for prompt.md
    const promptMdPath = join(registered.jobDir, "prompt.md")
    const promptPath = existsSync(promptMdPath) ? promptMdPath : null

    jobs.push({
      id: def.id,
      description: def.description,
      triggers: {
        events: events.length > 0 ? events : undefined,
      },
      config,
      eventEnabled: config.event_enabled === true,
      promptPath,
      lastRun,
      lastManualRun,
    })
  }

  return jobs
}

export function saveJobConfig(jobId: string, config: Record<string, unknown>): boolean {
  const registered = registeredJobs.get(jobId)
  if (!registered) return false
  const configPath = join(registered.jobDir, "config.json")
  mkdirSync(registered.jobDir, { recursive: true })
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8")
  return true
}

export interface JobRunInfo {
  id: string
  jobId: string
  trigger: string
  status: string
  startedAt: string
  finishedAt: string | null
  error: string | null
  result: Record<string, unknown> | null
}

export async function getJobRuns(
  db: Client,
  jobId?: string,
  offset = 0,
  limit = 50,
  ensureRunId?: string,
  dateFrom?: string,
): Promise<{ runs: JobRunInfo[]; total: number }> {
  const filters: string[] = []
  const args: (string | number)[] = []

  if (jobId) {
    filters.push("job_id = ?")
    args.push(jobId)
  }
  if (dateFrom) {
    filters.push("started_at >= ?")
    args.push(dateFrom)
  }

  const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : ""

  const countResult = await db.execute({
    sql: `SELECT COUNT(*) as cnt FROM job_runs ${whereClause}`,
    args,
  })
  const total = Number(countResult.rows[0]?.cnt ?? 0)

  const queryResult = await db.execute({
    sql: `SELECT id, job_id, trigger, status, started_at, finished_at, error, result FROM job_runs ${whereClause} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
    args: [...args, limit, offset],
  })

  const parseRow = (row: any): JobRunInfo => {
    let parsedResult: Record<string, unknown> | null = null
    if (row.result) {
      try { parsedResult = JSON.parse(String(row.result)) } catch { /* ignore */ }
    }
    return {
      id: String(row.id),
      jobId: String(row.job_id),
      trigger: String(row.trigger),
      status: String(row.status),
      startedAt: String(row.started_at),
      finishedAt: row.finished_at ? String(row.finished_at) : null,
      error: row.error ? String(row.error) : null,
      result: parsedResult,
    }
  }

  const runs: JobRunInfo[] = queryResult.rows.map(parseRow)

  // If a specific run was requested and isn't in the current page, fetch and prepend it
  if (ensureRunId && !runs.some((r) => r.id === ensureRunId)) {
    try {
      const singleResult = await db.execute({
        sql: "SELECT id, job_id, trigger, status, started_at, finished_at, error, result FROM job_runs WHERE id = ?",
        args: [ensureRunId],
      })
      if (singleResult.rows.length > 0) {
        runs.unshift(parseRow(singleResult.rows[0]))
      }
    } catch { /* ignore — best effort */ }
  }

  return { runs, total }
}

export function triggerManualRun(jobId: string, params?: Record<string, unknown>): { ok: boolean; runId?: string; error?: string } {
  const registered = registeredJobs.get(jobId)
  if (!registered) {
    return { ok: false, error: `Job "${jobId}" not found` }
  }
  if (!_db) {
    return { ok: false, error: "Database not available" }
  }

  const db = _db

  // Fire-and-forget: run in background, job controls its own recording
  if (registered.def.run) {
    const ctx: import("./jobs/types.js").JobContext = {
      db,
      jobDir: registered.jobDir,
      log: createLogger(`job:${jobId}`),
      trigger: "manual",
      params,
      schedule() { /* no-op for manual runs */ },
      on() { /* no-op for manual runs */ },
      triggerRun() {
        if (registered.def.run) {
          runJobWithContext(db, registered.def, ctx, "self")
        }
      },
      async recordRun(result: Record<string, unknown>) {
        return recordCompletedRun(db, jobId, "manual", result)
      },
      invalidateCache() {
        invalidateVisualizerCache()
      },
    }
    runJobWithContext(db, registered.def, ctx, "manual")
    return { ok: true }
  }

  // Fallback: use first registered handler (auto-recorded)
  const fn = registered.scheduleFns[0] ?? registered.eventFns[0]
  if (!fn) {
    return { ok: false, error: `Job "${jobId}" has no runnable handler` }
  }

  executeJobFn(db, jobId, "manual", () => fn())
  return { ok: true }
}
