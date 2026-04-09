/**
 * Logging module.
 *
 * In development: uses pino-pretty for human-readable output (loaded from devDependencies).
 * In production (packaged app): uses pino.multistream with pino.destination for
 * synchronous stdout + file output (no worker threads, bundle-friendly).
 * Log level is read from settings.json (default: "warn").
 */

import pino from "pino"
import { join } from "node:path"
import { homedir } from "node:os"
import { existsSync, readFileSync, mkdirSync, statSync, writeFileSync } from "node:fs"

type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal"

const MAX_LOG_BYTES = 2 * 1024 * 1024

/** Inlined to avoid circular dependency with config.ts */
function getProfileDir(): string {
  return process.env.LATENT_INFO_PROFILE_DIR ?? join(homedir(), ".latent_info")
}

function readLogLevel(): LogLevel {
  try {
    const settingsPath = join(getProfileDir(), "settings.json")
    if (existsSync(settingsPath)) {
      const raw = readFileSync(settingsPath, "utf-8")
      const settings = JSON.parse(raw) as { logLevel?: string }
      if (settings.logLevel) {
        const level = settings.logLevel.toLowerCase()
        if (["trace", "debug", "info", "warn", "error", "fatal"].includes(level)) {
          return level as LogLevel
        }
      }
    }
  } catch {
    // fall through to default
  }
  return "warn"
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function tailLogFile(filePath: string): void {
  try {
    if (!existsSync(filePath)) return
    const stat = statSync(filePath)
    if (stat.size <= MAX_LOG_BYTES) return
    const content = readFileSync(filePath, "utf-8")
    const keepFrom = content.indexOf("\n", Math.floor(content.length / 2))
    if (keepFrom > 0) {
      writeFileSync(filePath, content.slice(keepFrom + 1))
    }
  } catch {
    // ignore
  }
}

function getBackendLogPath(): string {
  const logsDir = join(getProfileDir(), "logs")
  ensureDir(logsDir)
  const logPath = join(logsDir, "backend.log")
  tailLogFile(logPath)
  return logPath
}

function hasPinoPretty(): boolean {
  try {
    require.resolve("pino-pretty")
    return true
  } catch {
    return false
  }
}

const level = readLogLevel()
const backendLogFile = getBackendLogPath()

function buildLogger(): pino.Logger {
  if (hasPinoPretty()) {
    // Development: use pino-pretty via transport (worker threads — fine when running from source)
    return pino({
      level,
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
      transport: {
        targets: [
          {
            target: "pino-pretty",
            level,
            options: {
              colorize: true,
              translateTime: "HH:MM:ss.l",
              ignore: "pid,hostname",
              singleLine: true,
            },
          },
          {
            target: "pino-pretty",
            level,
            options: {
              colorize: false,
              translateTime: "yyyy-mm-dd HH:MM:ss.l",
              ignore: "pid,hostname",
              singleLine: true,
              destination: backendLogFile,
              mkdir: true,
            },
          },
        ],
      },
    })
  }

  // Production: synchronous multistream (no worker threads, bundle-friendly)
  const fileDestination = pino.destination({ dest: backendLogFile, mkdir: true, sync: false })
  return pino(
    {
      level,
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream([
      { level: level as pino.Level, stream: process.stdout },
      { level: level as pino.Level, stream: fileDestination },
    ]),
  )
}

const logger = buildLogger()

export function createLogger(component: string): pino.Logger {
  return logger.child({ component })
}

export default logger
export { backendLogFile as logFile, level as logLevel }
