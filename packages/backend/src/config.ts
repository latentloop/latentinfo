/**
 * Configuration management.
 *
 * The Electron app embeds the backend instead of listening on a TCP port.
 * Profile directory: ~/.latent_info/
 */

import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { createLogger } from "./logger.js"

const log = createLogger("config")

export interface AppConfig {
  profileDir: string
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
  return { profileDir: getProfileDir() }
}
