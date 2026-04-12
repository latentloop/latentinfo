/**
 * Electron main process for LatentInfo.
 *
 * - Spawns the backend as a child process
 * - Waits for backend health check before creating the window
 * - Creates BrowserWindow pointing to the frontend
 * - System tray with show/hide
 * - Hide on close (minimize to tray) instead of quit
 * - Cmd+Q actually quits, kills backend child process
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
} from "electron"
import { spawn, type ChildProcess } from "node:child_process"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { get as httpGet } from "node:http"
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

const BACKEND_HOST = "127.0.0.1"
const BACKEND_PORT = 9821
const BACKEND_URL = `http://${BACKEND_HOST}:${BACKEND_PORT}`

const VITE_DEV_URL = process.env.VITE_DEV_URL || "http://localhost:5173"

const HEALTH_POLL_INTERVAL_MS = 500
const HEALTH_TIMEOUT_MS = 10_000

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null

/** Whether the macOS dock API is available. */
const hasDock = process.platform === "darwin"
let tray: Tray | null = null
let backendProcess: ChildProcess | null = null
let isQuitting = false

// ---------------------------------------------------------------------------
// Backend management
// ---------------------------------------------------------------------------

function spawnBackend(): ChildProcess {
  const isPackaged = app.isPackaged

  let command: string
  let args: string[]

  if (isPackaged) {
    // Production: backend is bundled into resources, use Electron's bundled Node.js
    const backendEntry = join(process.resourcesPath, "backend", "dist", "bundle.mjs")
    if (!existsSync(backendEntry)) {
      dialog.showErrorBox("Backend Missing", `Backend not found at:\n${backendEntry}`)
      app.quit()
    }
    const frontendDir = join(process.resourcesPath, "frontend")
    command = process.execPath
    args = [backendEntry, "--static-dir", frontendDir]
  } else {
    // Development: use tsx to run TypeScript source directly
    // NOTE: process.execPath is the Electron binary, not node — use "node" from PATH
    const backendSrc = join(__dirname, "..", "..", "backend", "src", "index.ts")
    const backendWatchPath = join(__dirname, "..", "..", "backend", "src")
    command = "node"

    // In test mode, no --watch (tests need stable process)
    const staticDir = process.env.LATENT_INFO_STATIC_DIR
    if (staticDir) {
      args = ["--import=tsx/esm", backendSrc, "--static-dir", staticDir]
    } else {
      // Dev mode: --watch auto-restarts backend on source changes
      args = ["--watch", "--watch-path", backendWatchPath, "--import=tsx/esm", backendSrc]
    }
  }

  // When reusing the Electron binary as a Node runtime, ELECTRON_RUN_AS_NODE
  // must be set; in dev mode explicitly clear it to prevent env inheritance.
  const backendEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: isPackaged ? "1" : "",
  }

  console.log(`[gui] Spawning backend: ${command} ${args.join(" ")}`)

  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: backendEnv,
  })

  child.stdout?.on("data", (data: Buffer) => {
    process.stdout.write(`[backend] ${data.toString()}`)
  })

  child.stderr?.on("data", (data: Buffer) => {
    process.stderr.write(`[backend:err] ${data.toString()}`)
  })

  child.on("exit", (code, signal) => {
    console.log(`[gui] Backend exited (code=${code}, signal=${signal})`)
    backendProcess = null
  })

  child.on("error", (err) => {
    console.error(`[gui] Failed to spawn backend:`, err)
    backendProcess = null
  })

  return child
}

function killBackend(): void {
  if (!backendProcess) return
  console.log("[gui] Killing backend process")
  backendProcess.kill("SIGTERM")
  // Force kill after a grace period
  const pid = backendProcess.pid
  setTimeout(() => {
    try {
      if (pid) process.kill(pid, "SIGKILL")
    } catch {
      // already dead
    }
  }, 3000)
  backendProcess = null
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

function checkHealth(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpGet(`${BACKEND_URL}/health`, (res) => {
      resolve(res.statusCode === 200)
      res.resume() // consume response data to free memory
    })
    req.on("error", () => resolve(false))
    req.setTimeout(2000, () => {
      req.destroy()
      resolve(false)
    })
  })
}

async function waitForBackend(): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < HEALTH_TIMEOUT_MS) {
    if (!backendProcess) return false // process already exited
    const ok = await checkHealth()
    if (ok) return true
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS))
  }
  return false
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
    backgroundColor: "#111110", // warm dark theme background
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

  // Show when ready to prevent white flash
  win.once("ready-to-show", () => {
    win.show()
  })

  // Hide on close instead of destroying (tray keeps running).
  // Show the tray notification first (if not yet dismissed), then hide.
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

  // Open external links in the default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) {
      shell.openExternal(url)
    }
    return { action: "deny" }
  })

  // Load the frontend.
  // In packaged or static-dir mode, load from the backend's static serving. In dev, use Vite.
  const useBackend = app.isPackaged || !!process.env.LATENT_INFO_STATIC_DIR
  const loadUrl = useBackend ? BACKEND_URL : VITE_DEV_URL
  console.log(`[gui] Loading: ${loadUrl}`)
  win.loadURL(loadUrl)

  // Re-focus webview on window focus (alt-tab back) so keyboard shortcuts work
  win.on("focus", () => {
    win.webContents.focus()
  })

  // Open devtools only for the real Vite-driven development flow.
  if (!useBackend && process.env.NODE_ENV !== "test") {
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

  // Left click opens the dashboard on macOS
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
    // App menu (macOS only)
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
    // File menu
    {
      label: "File",
      submenu: [
        {
          label: "Find",
          accelerator: "CmdOrCtrl+F",
          click: () => {
            // Forward Cmd+F to the webview so the frontend can handle it
            mainWindow?.webContents.executeJavaScript(
              `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true }))`,
            )
          },
        },
        { type: "separator" as const },
        isMac ? { role: "close" as const } : { role: "quit" as const },
      ],
    },
    // Edit menu
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
    // View menu
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
    // Window menu
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
    // Help menu
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

app.on("before-quit", () => {
  isQuitting = true
})

app.on("quit", () => {
  killBackend()
})

app.on("window-all-closed", () => {
  // On macOS, keep the app running in the tray even when all windows are closed.
  // On other platforms, quit.
  if (process.platform !== "darwin") {
    app.quit()
  }
})

app.on("activate", () => {
  // On macOS, re-create the window when dock icon is clicked and no windows exist
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

  // Set dock icon on macOS
  if (hasDock && app.dock) {
    const dockIcon = nativeImage.createFromPath(join(__dirname, "..", "icons", "app-icon-512.png"))
    app.dock.setIcon(dockIcon)
  }

  buildAppMenu()

  // Spawn backend
  backendProcess = spawnBackend()

  // Wait for backend to become healthy
  console.log("[gui] Waiting for backend health check...")
  const healthy = await waitForBackend()

  if (!healthy) {
    console.error("[gui] Backend did not become healthy within timeout")
    dialog.showErrorBox(
      "Backend Start Failed",
      `LatentInfo could not start the backend server within ${HEALTH_TIMEOUT_MS / 1000} seconds.\n\n` +
        "Please check the logs and ensure port 9821 is available.",
    )
    app.quit()
    return
  }

  console.log("[gui] Backend is healthy")

  // Create system tray
  tray = createTray()

  // Create main window
  mainWindow = createMainWindow()
}

bootstrap().catch((err) => {
  console.error("[gui] Fatal startup error:", err)
  app.quit()
})
