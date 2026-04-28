import { contextBridge, ipcRenderer } from "electron"
import { homedir } from "node:os"

type BackendEventHandler = (event: string, data: unknown) => void

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  homedir: homedir(),
  apiBase: "latent-info://app",
  saveImageAs: (imageBuffer: ArrayBuffer, defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke("dialog:saveImageAs", imageBuffer, defaultName),
  showInFolder: (filePath: string): void => {
    ipcRenderer.send("shell:showInFolder", filePath)
  },
  openPath: (dirPath: string): void => {
    ipcRenderer.send("shell:openPath", dirPath)
  },
  openDirectory: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke("dialog:openDirectory", defaultPath),
  onBackendEvent: (handler: BackendEventHandler): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { event: string; data: unknown }) => {
      handler(payload.event, payload.data)
    }
    ipcRenderer.on("backend:event", listener)
    ipcRenderer.send("backend-events:subscribe")
    return () => {
      ipcRenderer.off("backend:event", listener)
      ipcRenderer.send("backend-events:unsubscribe")
    }
  },
})
