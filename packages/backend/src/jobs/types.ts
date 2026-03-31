import type { Client } from "@libsql/client"

export interface JobDefinition {
  id: string
  description: string
  /** Data files to seed into <profileDir>/jobs/<id>/ on first run */
  dataFiles?: string[]
  register(ctx: JobContext): void | Promise<void>
  /** Explicit run method for manual/direct invocation. Returns structured result. */
  run?(ctx: JobContext): Promise<Record<string, unknown>>
}

export interface JobContext {
  db: Client
  schedule(intervalMs: number, fn: () => void | Promise<void>): void
  on(event: string, fn: (payload?: unknown) => void | Promise<void>): void
  /** Request another run of this job (fire-and-forget, respects debounce in run()). */
  triggerRun(): void
  /** Record a completed run in job_runs. Call this from run() when meaningful work was done. */
  recordRun(result: Record<string, unknown>): Promise<string>
  /** Invalidate visualizer caches so fresh data appears on next request. */
  invalidateCache(): void
  log: { info(msg: string): void; warn(msg: string): void; error(msg: string): void; debug(msg: string): void }
  /** Absolute path to this job's data directory in the profile */
  jobDir: string
  /** What triggered this run (e.g., "manual", "x:collected", "schedule") */
  trigger?: string
  /** Parameters passed to manual runs (from POST body) */
  params?: Record<string, unknown>
}
