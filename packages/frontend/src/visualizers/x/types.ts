// Raw tweet content from X.com
export interface XRawData {
  url: string
  tweetId: string
  text: string
  tweetAt: string
  displayName: string
  handle: string
  avatarUrl: string
  imageUrls: string[]
  contentLinks: { url: string; text: string }[]
  quotedTweetUrl: string
  cardLink: string
  parentTweetUrl: string
  articleHtml?: string
  articleTitle?: string
}

// Collection and derived metadata
export interface XInfo {
  id: string
  collectedAt: string
  scrapeDate: string
  scrapeHour: number
  tweetHour: number
  hasScreenshot: boolean
  tags?: string[]
  articleProcessed?: boolean
}

export interface XItem {
  rawData: XRawData
  info: XInfo
}

export interface XListResponse {
  items: XItem[]
  offset: number
  limit: number
  hasMore: boolean
}

export interface XSummaryResponse {
  total: number
}
