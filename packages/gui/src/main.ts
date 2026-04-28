/**
 * Electron main process for LatentInfo.
 *
 * - Starts the backend in-process
 * - Exposes backend routes through the latent-info://app custom protocol
 * - Creates BrowserWindow pointing to the custom protocol frontend
 * - System tray with show/hide
 * - Hide on close (minimize to tray) instead of quit
 */

import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  shell,
  nativeImage,
  dialog,
  ipcMain,
  protocol,
  type WebContents,
} from "electron"
import { join, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { writeFile, readFile } from "node:fs/promises"
import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const _home = homedir()

/** Expand ~/... to absolute path. */
function expandHome(path: string): string {
  if (path === "~") return _home
  if (path.startsWith("~/")) return join(_home, path.slice(2))
  return path
}

/** Shorten absolute path for display: replace homedir prefix with ~. */
function shortenHome(path: string): string {
  if (path === _home) return "~"
  if (path.startsWith(_home + "/")) return "~" + path.slice(_home.length)
  return path
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const APP_PROTOCOL = "latent-info"
const APP_ORIGIN = `${APP_PROTOCOL}://app`
const VITE_DEV_URL = process.env.VITE_DEV_URL || "http://127.0.0.1:5173"

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
])

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null

/** Whether the macOS dock API is available. */
const hasDock = process.platform === "darwin"
let tray: Tray | null = null
let isQuitting = false
let isStoppingBackend = false
let backend: EmbeddedBackend | null = null
let backendEventsCleanup: (() => void) | null = null
const backendEventSubscribers = new Set<WebContents>()
let signalShutdown: Promise<void> | null = null

interface BackendEvent {
  event: string
  data: unknown
}

interface EmbeddedBackend {
  handleRequest(request: Request): Promise<Response>
  onEvent(listener: (payload: BackendEvent) => void): () => void
  stop(): Promise<void>
}

interface BackendModule {
  startBackend(options?: { staticDir?: string }): Promise<EmbeddedBackend>
}

// ---------------------------------------------------------------------------
// Backend management
// ---------------------------------------------------------------------------

function getStaticDir(): string | undefined {
  if (process.env.LATENT_INFO_STATIC_DIR) return process.env.LATENT_INFO_STATIC_DIR
  if (app.isPackaged) return join(process.resourcesPath, "frontend")
  return undefined
}

async function loadBackendModule(): Promise<BackendModule> {
  if (app.isPackaged) {
    const backendPackage = "backend/embedded"
    return await import(backendPackage) as BackendModule
  }
  const backendDist = join(__dirname, "..", "..", "backend", "dist", "embedded.js")
  return await import(pathToFileURL(backendDist).href) as BackendModule
}

async function startEmbeddedBackend(): Promise<void> {
  if (backend) return
  const module = await loadBackendModule()
  backend = await module.startBackend({ staticDir: getStaticDir() })
  backendEventsCleanup = backend.onEvent((payload) => {
    for (const webContents of backendEventSubscribers) {
      if (webContents.isDestroyed()) {
        backendEventSubscribers.delete(webContents)
        continue
      }
      webContents.send("backend:event", payload)
    }
  })
}

async function stopEmbeddedBackend(): Promise<void> {
  if (!backend) return
  const handle = backend
  backend = null
  backendEventsCleanup?.()
  backendEventsCleanup = null
  backendEventSubscribers.clear()
  await handle.stop()
}

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

function isBackendPath(pathname: string): boolean {
  return pathname === "/health" || pathname.startsWith("/api/") || pathname.startsWith("/app/")
}

function viteUrlFor(requestUrl: URL): string {
  const viteUrl = new URL(VITE_DEV_URL)
  viteUrl.pathname = requestUrl.pathname
  viteUrl.search = requestUrl.search
  return viteUrl.href
}

function registerProtocolHandler(): void {
  protocol.handle(APP_PROTOCOL, async (request) => {
    const url = new URL(request.url)

    if (!backend) {
      return new Response(JSON.stringify({ error: "Backend not started" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      })
    }

    const useVite = !app.isPackaged && !process.env.LATENT_INFO_STATIC_DIR
    if (useVite && !isBackendPath(url.pathname)) {
      return fetch(viteUrlFor(url))
    }

    return backend.handleRequest(request)
  })
}

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------

function createMainWindow(): BrowserWindow {
  const appIconPath = join(__dirname, "..", "icons", "app-icon-512.png")
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#111110",
    icon: appIconPath,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    show: false,
    webPreferences: {
      preload: join(__dirname, app.isPackaged ? "preload.js" : "preload.ts"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  win.once("ready-to-show", () => {
    win.show()
  })

  win.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault()
      showTrayNotificationOnce(win)
        .catch((err) => console.error("[gui] Tray notification error:", err))
        .finally(() => {
          win.hide()
          if (hasDock && app.dock) {
            app.dock.hide()
          }
        })
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) {
      shell.openExternal(url)
    }
    return { action: "deny" }
  })

  const loadUrl = `${APP_ORIGIN}/`
  console.log(`[gui] Loading: ${loadUrl}`)
  win.loadURL(loadUrl)

  win.on("focus", () => {
    win.webContents.focus()
  })

  if (!app.isPackaged && process.env.NODE_ENV !== "test") {
    win.webContents.openDevTools({ mode: "detach" })
  }

  return win
}

// ---------------------------------------------------------------------------
// System tray
// ---------------------------------------------------------------------------

function createTray(): Tray {
  const iconPath = join(__dirname, "..", "icons", "tray-icon.png")
  const icon = nativeImage.createFromPath(iconPath)
  icon.setTemplateImage(true)

  const systemTray = new Tray(icon)
  systemTray.setToolTip("LatentInfo")

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Open Dashboard",
      click: () => showMainWindow(),
    },
    { type: "separator" },
    {
      label: "Quit LatentInfo",
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ])

  systemTray.setContextMenu(contextMenu)
  systemTray.on("click", () => {
    showMainWindow()
  })

  return systemTray
}

export async function showMainWindow(): Promise<void> {
  if (mainWindow) {
    if (hasDock && app.dock) {
      try {
        await app.dock.show()
      } catch (err) {
        console.error("[gui] Failed to show dock icon:", err)
      }
    }
    mainWindow.show()
    mainWindow.focus()
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
  }
}

// ---------------------------------------------------------------------------
// Application menu
// ---------------------------------------------------------------------------

function buildAppMenu(): void {
  const isMac = process.platform === "darwin"

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "Find",
          accelerator: "CmdOrCtrl+F",
          click: () => {
            mainWindow?.webContents.executeJavaScript(
              `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true }))`,
            )
          },
        },
        { type: "separator" as const },
        isMac ? { role: "close" as const } : { role: "quit" as const },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" as const },
        { role: "redo" as const },
        { type: "separator" as const },
        { role: "cut" as const },
        { role: "copy" as const },
        { role: "paste" as const },
        { role: "selectAll" as const },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" as const },
        { role: "forceReload" as const },
        { role: "toggleDevTools" as const },
        { type: "separator" as const },
        { role: "resetZoom" as const },
        { role: "zoomIn" as const },
        { role: "zoomOut" as const },
        { type: "separator" as const },
        { role: "togglefullscreen" as const },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" as const },
        { role: "zoom" as const },
        ...(isMac
          ? [
              { type: "separator" as const },
              { role: "front" as const },
            ]
          : [{ role: "close" as const }]),
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "Learn More",
          click: () => {
            shell.openExternal("https://github.com/latent-info")
          },
        },
      ],
    },
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

ipcMain.handle(
  "dialog:saveImageAs",
  async (event, imageBuffer: ArrayBuffer, defaultName: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const { canceled, filePath } = await dialog.showSaveDialog(win!, {
      defaultPath: defaultName,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
    })
    if (canceled || !filePath) return null
    await writeFile(filePath, Buffer.from(imageBuffer))
    return filePath
  },
)

ipcMain.on("shell:showInFolder", (_event, filePath: string) => {
  shell.showItemInFolder(expandHome(filePath))
})

ipcMain.on("shell:openPath", (_event, dirPath: string) => {
  const resolved = expandHome(dirPath)
  if (!existsSync(resolved)) mkdirSync(resolved, { recursive: true })
  shell.openPath(resolved)
})

ipcMain.handle(
  "dialog:openDirectory",
  async (event, defaultPath?: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    let resolved = defaultPath ? expandHome(defaultPath) : defaultPath
    while (resolved && !existsSync(resolved)) resolved = dirname(resolved)
    const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
      defaultPath: resolved || undefined,
      properties: ["openDirectory", "createDirectory"],
    })
    if (canceled || filePaths.length === 0) return null
    return shortenHome(filePaths[0]!)
  },
)

ipcMain.on("backend-events:subscribe", (event) => {
  backendEventSubscribers.add(event.sender)
})

ipcMain.on("backend-events:unsubscribe", (event) => {
  backendEventSubscribers.delete(event.sender)
})

// ---------------------------------------------------------------------------
// Tray minimize notification
// ---------------------------------------------------------------------------

function getSettingsPath(): string {
  const profileDir = process.env.LATENT_INFO_PROFILE_DIR ?? join(homedir(), ".latent_info")
  return join(profileDir, "settings.json")
}

async function readSettings(): Promise<Record<string, unknown>> {
  const p = getSettingsPath()
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(await readFile(p, "utf-8"))
  } catch {
    return {}
  }
}

async function writeSettings(settings: Record<string, unknown>): Promise<void> {
  await writeFile(getSettingsPath(), JSON.stringify(settings, null, 2), "utf-8")
}

async function showTrayNotificationOnce(win: BrowserWindow): Promise<void> {
  const settings = await readSettings()
  if (settings.hideToTrayNotified) return

  const { checkboxChecked } = await dialog.showMessageBox(win, {
    type: "info",
    title: "LatentInfo",
    message: "LatentInfo will be minimized",
    detail: "The app will keep running in the background. Click the tray icon to reopen.",
    buttons: ["OK"],
    checkboxLabel: "Don't show this again",
    checkboxChecked: false,
  })

  if (checkboxChecked) {
    settings.hideToTrayNotified = true
    await writeSettings(settings)
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.on("before-quit", (event) => {
  isQuitting = true
  if (backend && !isStoppingBackend) {
    event.preventDefault()
    isStoppingBackend = true
    stopEmbeddedBackend()
      .catch((err) => console.error("[gui] Backend shutdown error:", err))
      .finally(() => app.quit())
  }
})

function shutdownFromSignal(signal: NodeJS.Signals): void {
  if (signalShutdown) {
    app.exit(0)
    return
  }

  console.log(`[gui] Received ${signal}, shutting down...`)
  isQuitting = true
  isStoppingBackend = true

  const forceExit = setTimeout(() => {
    console.warn("[gui] Shutdown timed out; exiting")
    app.exit(0)
  }, 3000)
  forceExit.unref?.()

  signalShutdown = stopEmbeddedBackend()
    .catch((err) => console.error("[gui] Backend shutdown error:", err))
    .finally(() => {
      clearTimeout(forceExit)
      app.exit(0)
    })
}

process.once("SIGINT", shutdownFromSignal)
process.once("SIGTERM", shutdownFromSignal)

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})

app.on("activate", () => {
  if (mainWindow === null || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow()
  } else {
    showMainWindow()
  }
})

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function bootstrap(): Promise<void> {
  await app.whenReady()

  if (hasDock && app.dock) {
    const dockIcon = nativeImage.createFromPath(join(__dirname, "..", "icons", "app-icon-512.png"))
    app.dock.setIcon(dockIcon)
  }

  console.log("[gui] Starting embedded backend...")
  await startEmbeddedBackend()
  registerProtocolHandler()
  console.log("[gui] Embedded backend is ready")

  buildAppMenu()
  tray = createTray()
  mainWindow = createMainWindow()
}

bootstrap().catch((err) => {
  console.error("[gui] Fatal startup error:", err)
  app.quit()
})
