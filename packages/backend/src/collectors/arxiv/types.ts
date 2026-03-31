export interface ArxivVersionEntry {
  version: string    // "v1", "v2", etc.
  date: string       // ISO datetime
  size: string       // "1,162 KB"
}

export interface ArxivDocument {
  arxivId: string
  title: string
  authors: string[]
  abstract: string
  categories: string[]
  submittedAt: string
  pdfUrl: string
  url: string
  collectedAt: string
  collectedBy: "arxiv"
  versions?: ArxivVersionEntry[]
}
