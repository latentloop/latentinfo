/**
 * Per-collector configuration management.
 *
 * Each collector gets its own directory under <profileDir>/collectors/<collectorId>/
 * with a config.json file for collector-specific settings.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { EventEmitter } from "node:events"
import { getProfileDir } from "./config.js"
import { createLogger } from "./logger.js"

const log = createLogger("collector-config")

export interface CollectorSettings {
  enabled?: boolean
  freshMinutes?: number
  freshUnit?: "sec" | "min"
  auto_detect?: Record<string, boolean>
  logLevel?: "trace" | "debug" | "info" | "warn" | "error" | "fatal"
}

export function getCollectorsDir(): string {
  return join(getProfileDir(), "collectors")
}

export function getCollectorDir(collectorId: string): string {
  return join(getCollectorsDir(), collectorId)
}

export function ensureCollectorDir(collectorId: string): void {
  const dir = getCollectorDir(collectorId)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

export function loadCollectorConfig(collectorId: string): CollectorSettings {
  const configPath = join(getCollectorDir(collectorId), "config.json")
  if (!existsSync(configPath)) return {}
  try {
    return JSON.parse(readFileSync(configPath, "utf-8")) as CollectorSettings
  } catch {
    log.warn(`Invalid config.json for collector "${collectorId}", using defaults`)
    return {}
  }
}

// ---------------------------------------------------------------------------
// Config change events — decouples config writes from consumers (e.g. action handlers)
// ---------------------------------------------------------------------------

type ConfigChangedCallback = (collectorId: string, config: CollectorSettings) => void

const configEmitter = new EventEmitter()

export function onCollectorConfigChanged(callback: ConfigChangedCallback): void {
  configEmitter.on("changed", callback)
}

export function offCollectorConfigChanged(callback: ConfigChangedCallback): void {
  configEmitter.off("changed", callback)
}

export function saveCollectorConfig(collectorId: string, config: CollectorSettings): void {
  ensureCollectorDir(collectorId)
  const configPath = join(getCollectorDir(collectorId), "config.json")
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8")
  try {
    configEmitter.emit("changed", collectorId, config)
  } catch (e) {
    log.error(e, `Error in config-changed listener for "${collectorId}"`)
  }
}
