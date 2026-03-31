interface ElectronAPI {
  platform: string
  homedir: string
  saveImageAs: (imageBuffer: ArrayBuffer, defaultName: string) => Promise<string | null>
  showInFolder: (filePath: string) => void
  openPath: (dirPath: string) => void
  openDirectory: (defaultPath?: string) => Promise<string | null>
}

interface Window {
  electronAPI?: ElectronAPI
}
