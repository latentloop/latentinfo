/**
 * Backend entry point.
 */

import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { config as loadDotenv } from "dotenv"
import { loadConfig, getProfileDir } from "./config.js"
import { loadSettings } from "./settings.js"
import { initDatabase } from "./storage/db.js"
import { startServer, broadcastSseEvent } from "./server.js"
import { startBrowserMonitor } from "./browser-monitor.js"
import { initAttachQueue, requestAutoAttach } from "./attach-queue.js"
import collectors from "./collectors/index.js"
import { visualizers } from "./visualizers/index.js"
import jobs from "./jobs/index.js"
import { seedJobData, startJobRunner, stopJobRunner } from "./job-runner.js"
import { createLogger } from "./logger.js"

const log = createLogger("main")
const thisDir = dirname(fileURLToPath(import.meta.url))

loadDotenv({ path: join(thisDir, "..", ".env") })

async function main() {
  log.info("Starting backend...")

  const appConfig = loadConfig()
  log.info(`Config loaded from ${getProfileDir()}`)

  const settings = loadSettings()
  log.info(`${settings.browsers.length} browser(s) detected`)

  // Initialize document database
  const db = await initDatabase()

  // Initialize collectors
  for (const collector of collectors) {
    if (collector.initCollector) {
      await collector.initCollector(db)
      log.info(`Collector '${collector.id}' initialized`)
    }
  }

  // Start browser monitor
  // dialog_dismissed is mapped to "activate" so auto-attach retries after the dialog is gone.
  const monitor = startBrowserMonitor(settings.browsers, (event) => {
    requestAutoAttach(event === "dialog_dismissed" ? "activate" : event)
    // Push session list changes immediately to dashboard clients so the
    // overview page reflects a closed or newly launched browser without
    // waiting for a successful auto-attach.
    if (event === "launch" || event === "terminate") {
      broadcastSseEvent("session-changed", { event })
    }
  })

  // Configure dialog auto-allow from settings
  monitor.setDialogAutoAllow(!!settings.remoteDebuggingAutoAllow)
  log.info(`Dialog auto-allow ${settings.remoteDebuggingAutoAllow ? "enabled" : "disabled"}`)

  // Initialize attach queue
  initAttachQueue(
    settings.browsers,
    collectors,
    db,
    () => monitor.triggerDialogBurst(),
    (event, sessionName) => {
      log.info({ event, sessionName }, "Session change")
      broadcastSseEvent("session-changed", { event, sessionName })
    },
  )

  // Initialize visualizers
  for (const viz of visualizers) {
    if (viz.initVisualizer) {
      await viz.initVisualizer(db)
      log.info(`Visualizer '${viz.id}' initialized`)
    }
  }

  // Seed job data files and start job runner
  seedJobData(jobs)
  await startJobRunner(db, jobs)

  // Serve frontend static files if --static-dir is passed
  const staticDirIdx = process.argv.indexOf("--static-dir")
  const staticDir = staticDirIdx !== -1 ? process.argv[staticDirIdx + 1] : undefined

  const handle = await startServer({
    appConfig,
    staticDir,
    db,
    visualizers,
    browsers: settings.browsers,
    collectors,
    onSettingsChanged: (prev, next) => {
      // When auto-attach is enabled, immediately try attaching to frontmost Chrome
      if (!prev.autoAttach && next.autoAttach) {
        log.info("Auto-attach enabled via settings, triggering immediate attach")
        requestAutoAttach("activate")
      }
      // Always sync dialog auto-allow — ensures in-memory Swift state matches the persisted setting
      monitor.setDialogAutoAllow(!!next.remoteDebuggingAutoAllow)
      if (prev.remoteDebuggingAutoAllow !== next.remoteDebuggingAutoAllow) {
        log.info(`Dialog auto-allow ${next.remoteDebuggingAutoAllow ? "enabled" : "disabled"} via settings`)
      }
    },
  })

  process.on("SIGINT", async () => {
    log.info("Shutting down...")
    stopJobRunner()
    monitor.stop()
    handle.close()
    try { await db.close() } catch { /* ignore */ }
    process.exit(0)
  })

  process.on("SIGTERM", async () => {
    log.info("Received SIGTERM, shutting down...")
    stopJobRunner()
    monitor.stop()
    handle.close()
    try { await db.close() } catch { /* ignore */ }
    process.exit(0)
  })

  process.on("unhandledRejection", (reason) => {
    log.warn({ reason: String(reason) }, "Unhandled promise rejection")
  })

  process.on("uncaughtException", (err) => {
    log.warn({ err: err.message, stack: err.stack }, "Uncaught exception")
  })
}

main().catch((err) => {
  log.error(err, "Fatal error")
  process.exit(1)
})
