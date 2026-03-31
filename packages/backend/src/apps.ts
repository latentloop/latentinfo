/**
 * App discovery and loading.
 *
 * Scans profile directory subdirectories for apps:
 *   - app.yaml  -> single app
 *   - apps.yaml -> app group listing sub-app directories
 *
 * Each app.yaml can include a `route` field for custom HTTP route path
 * (e.g., route: "tab" serves at /app/tab instead of /app/tab_manager).
 *
 * Script files are always read from disk (never cached) to support live editing.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { parse as parseYaml } from "yaml"
import { getProfileDir } from "./config.js"
import { createLogger } from "./logger.js"

const log = createLogger("apps")

export interface AppDefinition {
  /** Directory name (e.g. "x_x") */
  dirName: string
  /** Absolute path to the app directory */
  dirPath: string
  /** App name from app.yaml */
  name: string
  /** HTTP route path (defaults to name). Served at /app/<route>/ */
  route: string
  /** App version */
  version: number
  /** Description */
  description: string
  /** Ordered list of script filenames under cdp_handlers (run once per CDP session) */
  cdpHandlers: string[]
  /** Ordered list of script filenames under page_handlers (run per matching page) */
  pageHandlers: string[]
  /** Ordered list of directory names under web_handlers (served under /app/<route>/) */
  webHandlers: string[]
  /** App type: "package" uses import() loader, otherwise VM sandbox */
  type: string
  /** Framework identifier (e.g. "tanstack-start") — empty string if unset */
  framework: string
}

interface AppYaml {
  name: string
  route?: string
  version?: number
  description?: string
  type?: string
  framework?: string
  cdp_handlers?: string[]
  page_handlers?: string[]
  web_handlers?: string[]
}

interface AppsGroupYaml {
  apps: string[]
}

function loadSingleApp(dirPath: string, dirName: string): AppDefinition | null {
  const yamlPath = join(dirPath, "app.yaml")
  if (!existsSync(yamlPath)) return null

  try {
    const raw = readFileSync(yamlPath, "utf-8")
    const parsed = parseYaml(raw) as AppYaml
    if (!parsed.name) return null

    return {
      dirName,
      dirPath,
      name: parsed.name,
      route: parsed.route || parsed.name,
      version: parsed.version ?? 1,
      description: parsed.description ?? "",
      cdpHandlers: Array.isArray(parsed.cdp_handlers) ? parsed.cdp_handlers : [],
      pageHandlers: Array.isArray(parsed.page_handlers) ? parsed.page_handlers : [],
      webHandlers: Array.isArray(parsed.web_handlers) ? parsed.web_handlers : [],
      type: typeof parsed.type === "string" ? parsed.type : "",
      framework: typeof parsed.framework === "string" ? parsed.framework : "",
    }
  } catch (e) {
    log.error(e, `Failed to load app ${dirName}`)
    return null
  }
}

/**
 * Discover all apps from profile directory subdirectories.
 * Always reads from disk — no caching.
 *
 * For each subdirectory under the profile dir:
 *   - If it contains apps.yaml -> treat as app group, load listed sub-apps
 *   - If it contains app.yaml  -> treat as single app
 *   - Otherwise skip
 */
export function loadApps(): AppDefinition[] {
  const profileDir = getProfileDir()
  if (!existsSync(profileDir)) return []

  const apps: AppDefinition[] = []

  let entries: string[]
  try {
    entries = readdirSync(profileDir)
  } catch {
    return []
  }

  for (const entry of entries) {
    const entryPath = join(profileDir, entry)
    try {
      const stat = statSync(entryPath)
      if (!stat.isDirectory() && !stat.isSymbolicLink()) continue
    } catch {
      continue
    }

    // Check for apps.yaml (app group with multiple sub-apps)
    const appsYamlPath = join(entryPath, "apps.yaml")
    if (existsSync(appsYamlPath)) {
      try {
        const raw = readFileSync(appsYamlPath, "utf-8")
        const parsed = parseYaml(raw) as AppsGroupYaml
        if (Array.isArray(parsed.apps)) {
          for (const subApp of parsed.apps) {
            const subPath = join(entryPath, String(subApp))
            const app = loadSingleApp(subPath, String(subApp))
            if (app) apps.push(app)
          }
        }
      } catch (e) {
        log.error(e, `Failed to load app group ${entry}`)
      }
      continue
    }

    // Check for app.yaml (single app)
    const app = loadSingleApp(entryPath, entry)
    if (app) apps.push(app)
  }

  return apps
}

/**
 * Read a script file from an app directory.
 * Always reads from disk to support live editing.
 */
export function loadAppScript(app: AppDefinition, scriptName: string): string | null {
  const scriptPath = join(app.dirPath, scriptName)
  if (!existsSync(scriptPath)) {
    log.error({ scriptPath }, "Script not found")
    return null
  }

  try {
    return readFileSync(scriptPath, "utf-8")
  } catch (e) {
    log.error(e, `Failed to read script ${scriptPath}`)
    return null
  }
}
