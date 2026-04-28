interface ElectronAPI {
  platform: string
  homedir: string
  apiBase: string
  saveImageAs: (imageBuffer: ArrayBuffer, defaultName: string) => Promise<string | null>
  showInFolder: (filePath: string) => void
  openPath: (dirPath: string) => void
  openDirectory: (defaultPath?: string) => Promise<string | null>
  onBackendEvent: (handler: (event: string, data: unknown) => void) => () => void
}

interface Window {
  electronAPI?: ElectronAPI
}
