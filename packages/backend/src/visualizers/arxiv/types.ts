import type { ArxivDocument, ArxivVersionEntry } from "../../collectors/arxiv/types.js"

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
  id: string  // document id: arxiv:<arxivId>
  collectedAt: string
  downloadPath?: string
}

// Item sent to frontend
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

export type { ArxivDocument }
