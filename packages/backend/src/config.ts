/**
 * Configuration management.
 *
 * Server config (host/port) is read from settings.json.
 * Falls back to defaults (127.0.0.1:9821).
 * Profile directory: ~/.latent_info/
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { createLogger } from "./logger.js"

const log = createLogger("config")

const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_PORT = 9821

export interface AppConfig {
  server: {
    port: number
    host: string
  }
}

export function getProfileDir(): string {
  return process.env.LATENT_INFO_PROFILE_DIR ?? join(homedir(), ".latent_info")
}

export function ensureProfileDir(): void {
  const profileDir = getProfileDir()
  if (!existsSync(profileDir)) {
    mkdirSync(profileDir, { recursive: true })
    log.debug({ profileDir }, "Created profile directory")
  }
}

export function loadConfig(): AppConfig {
  ensureProfileDir()
  const profileDir = getProfileDir()
  const settingsPath = join(profileDir, "settings.json")

  if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>
      const server = parsed.server as Record<string, unknown> | undefined
      if (server && typeof server === "object") {
        return {
          server: {
            port: typeof server.port === "number" ? server.port : DEFAULT_PORT,
            host: typeof server.host === "string" ? server.host : DEFAULT_HOST,
          },
        }
      }
    } catch {
      // fall through to defaults
    }
  }

  return { server: { port: DEFAULT_PORT, host: DEFAULT_HOST } }
}
