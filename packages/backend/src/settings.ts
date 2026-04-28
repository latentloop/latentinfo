/**
 * Settings management.
 *
 * Reads/writes ~/.latent_info/settings.json.
 * On first run, scans for installed Chrome browsers.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { execSync } from "node:child_process"
import { getProfileDir, ensureProfileDir } from "./config.js"
import { createLogger } from "./logger.js"

const log = createLogger("settings")

export interface BrowserEntry {
  name: string
  appPath: string
  profilePath: string
  version: string
}

export interface AppSettings {
  autoAttach: boolean
  browsers: BrowserEntry[]
  remoteDebuggingAutoAllow?: boolean
  logLevel?: string
}

const CHROME_VARIANTS: Record<string, string> = {
  "Chrome": "Google Chrome.app",
  "Chrome Canary": "Google Chrome Canary.app",
  "Chrome for Testing": "Google Chrome for Testing.app",
}

function getSettingsPath(): string {
  return join(getProfileDir(), "settings.json")
}

function readVersion(appPath: string): string {
  try {
    const raw = execSync(
      `defaults read "${appPath}/Contents/Info" CFBundleShortVersionString`,
      { encoding: "utf-8", timeout: 5000 },
    )
    return raw.trim()
  } catch {
    return "unknown"
  }
}

function scanChromeBrowsers(): BrowserEntry[] {
  const home = homedir()
  const googleDir = join(home, "Library", "Application Support", "Google")
  const entries: BrowserEntry[] = []

  if (!existsSync(googleDir)) return entries

  const dirs = readdirSync(googleDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)

  for (const [variantName, appName] of Object.entries(CHROME_VARIANTS)) {
    const profilePath = join(googleDir, variantName)
    if (!dirs.includes(variantName)) continue

    const appPath = join("/Applications", appName)
    if (!existsSync(appPath)) continue

    const version = readVersion(appPath)
    entries.push({
      name: variantName,
      appPath,
      profilePath,
      version,
    })
  }

  return entries
}

export function loadSettings(): AppSettings {
  ensureProfileDir()
  const settingsPath = getSettingsPath()

  if (existsSync(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, "utf-8")
      const parsed = JSON.parse(raw) as AppSettings
      if (Array.isArray(parsed.browsers)) {
        // Strip unknown fields from browser entries
        parsed.browsers = parsed.browsers.map((b: any) => ({
          name: b.name,
          appPath: b.appPath,
          profilePath: b.profilePath,
          version: b.version,
        }))

        return parsed
      }
    } catch {
      log.warn("Invalid settings.json, using defaults")
    }
  }

  log.info("First run detected, scanning for Chrome browsers...")
  const browsers = scanChromeBrowsers()
  const settings: AppSettings = { autoAttach: false, browsers }
  saveSettings(settings)
  log.info(`Found ${browsers.length} Chrome browser(s)`)
  return settings
}

/**
 * Extract and cache a browser's icon as PNG.
 * Converts the app bundle's .icns to a 40x40 PNG via macOS sips.
 */
export function getBrowserIcon(appPath: string): Buffer | null {
  const icnsPath = join(appPath, "Contents", "Resources", "app.icns")
  if (!existsSync(icnsPath)) return null

  const cacheDir = join(getProfileDir(), "icon-cache")
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true })

  const appName = appPath.split("/").pop()!.replace(/\.app$/, "")
  const cachePath = join(cacheDir, `${appName}.png`)

  if (!existsSync(cachePath)) {
    try {
      execSync(
        `sips -s format png -z 40 40 "${icnsPath}" --out "${cachePath}"`,
        { timeout: 5000, stdio: "ignore" },
      )
    } catch {
      return null
    }
  }

  try {
    return readFileSync(cachePath)
  } catch {
    return null
  }
}

export function saveSettings(settings: AppSettings): void {
  // Strip unknown fields from browser entries
  if (Array.isArray(settings.browsers)) {
    settings.browsers = settings.browsers.map((b) => ({
      name: b.name,
      appPath: b.appPath,
      profilePath: b.profilePath,
      version: b.version,
    }))
  }
  const settingsPath = getSettingsPath()
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8")
}
