export interface ArxivVersionEntry {
  version: string
  date: string
  size: string
}

// Paper content from arxiv.org
export interface ArxivRawData {
  arxivId: string
  title: string
  authors: string[]
  abstract: string
  categories: string[]
  submittedAt: string
  pdfUrl: string
  url: string
  versions?: ArxivVersionEntry[]
}

// Collection and derived metadata
export interface ArxivInfo {
  id: string
  collectedAt: string
  downloadPath?: string
}

export interface ArxivItem {
  rawData: ArxivRawData
  info: ArxivInfo
}

export interface ArxivListResponse {
  items: ArxivItem[]
  total: number
  offset: number
  limit: number
}
