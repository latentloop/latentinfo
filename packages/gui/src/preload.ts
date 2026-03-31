import { contextBridge, ipcRenderer } from "electron"
import { homedir } from "node:os"

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  homedir: homedir(),
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
})
