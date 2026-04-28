import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { config as loadDotenv } from "dotenv"
import { loadConfig, getProfileDir } from "./config.js"
import { loadSettings } from "./settings.js"
import { initDatabase } from "./storage/db.js"
import { createBackendApi, type BackendApi } from "./server.js"
import { startBrowserMonitor } from "./browser-monitor.js"
import { initAttachQueue, requestAutoAttach, globalDisableAll } from "./attach-queue.js"
import collectors from "./collectors/index.js"
import { visualizers } from "./visualizers/index.js"
import jobs from "./jobs/index.js"
import { seedJobData, startJobRunner, stopJobRunner } from "./job-runner.js"
import { emitBackendEvent, onBackendEvent, type BackendEvent } from "./events.js"
import { createLogger } from "./logger.js"

const log = createLogger("main")
const thisDir = dirname(fileURLToPath(import.meta.url))

loadDotenv({ path: join(thisDir, "..", ".env") })

export interface EmbeddedBackendOptions {
  staticDir?: string
}

export interface EmbeddedBackend {
  api: BackendApi
  handleRequest(request: Request): Promise<Response>
  onEvent(listener: (payload: BackendEvent) => void): () => void
  stop(): Promise<void>
}

export async function startBackend(options: EmbeddedBackendOptions = {}): Promise<EmbeddedBackend> {
  log.info("Starting backend...")

  loadConfig()
  log.info(`Config loaded from ${getProfileDir()}`)

  const settings = loadSettings()
  log.info(`${settings.browsers.length} browser(s) detected`)

  const db = await initDatabase()

  for (const collector of collectors) {
    if (collector.initCollector) {
      await collector.initCollector(db)
      log.info(`Collector '${collector.id}' initialized`)
    }
  }

  const monitor = startBrowserMonitor(settings.browsers, (event) => {
    requestAutoAttach(event === "dialog_dismissed" ? "activate" : event)
    if (event === "launch" || event === "terminate") {
      emitBackendEvent("session-changed", { event })
    }
  })

  monitor.setDialogAutoAllow(!!settings.remoteDebuggingAutoAllow)
  log.info(`Dialog auto-allow ${settings.remoteDebuggingAutoAllow ? "enabled" : "disabled"}`)

  initAttachQueue(
    settings.browsers,
    collectors,
    db,
    () => monitor.triggerDialogBurst(),
    (event, sessionName) => {
      log.info({ event, sessionName }, "Session change")
      emitBackendEvent("session-changed", { event, sessionName })
    },
  )

  for (const viz of visualizers) {
    if (viz.initVisualizer) {
      await viz.initVisualizer(db)
      log.info(`Visualizer '${viz.id}' initialized`)
    }
  }

  seedJobData(jobs)
  await startJobRunner(db, jobs)

  const api = await createBackendApi({
    staticDir: options.staticDir,
    db,
    visualizers,
    browsers: settings.browsers,
    collectors,
    onSettingsChanged: (prev, next) => {
      if (!prev.autoAttach && next.autoAttach) {
        log.info("Auto-attach enabled via settings, triggering immediate attach")
        requestAutoAttach("activate")
      }
      monitor.setDialogAutoAllow(!!next.remoteDebuggingAutoAllow)
      if (prev.remoteDebuggingAutoAllow !== next.remoteDebuggingAutoAllow) {
        log.info(`Dialog auto-allow ${next.remoteDebuggingAutoAllow ? "enabled" : "disabled"} via settings`)
      }
    },
  })

  let stopped = false

  return {
    api,
    handleRequest(request: Request): Promise<Response> {
      return api.handleRequest(request)
    },
    onEvent(listener: (payload: BackendEvent) => void): () => void {
      return onBackendEvent(listener)
    },
    async stop(): Promise<void> {
      if (stopped) return
      stopped = true
      log.info("Shutting down...")
      stopJobRunner()
      globalDisableAll()
      monitor.stop()
      api.close()
      try { await db.close() } catch { /* ignore */ }
    },
  }
}
