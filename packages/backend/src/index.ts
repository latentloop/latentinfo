/**
 * Backend CLI entry point.
 *
 * The backend no longer opens a local HTTP server. The Electron GUI imports
 * the same embedded service and exposes it through a custom protocol.
 */

import { startBackend } from "./embedded.js"
import { createLogger } from "./logger.js"

const log = createLogger("main")

async function main() {
  const staticDirIdx = process.argv.indexOf("--static-dir")
  const staticDir = staticDirIdx !== -1 ? process.argv[staticDirIdx + 1] : undefined
  const handle = await startBackend({ staticDir })

  const shutdown = async (signal: string) => {
    log.info({ signal }, "Received shutdown signal")
    await handle.stop()
    process.exit(0)
  }

  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("SIGTERM", () => void shutdown("SIGTERM"))

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
