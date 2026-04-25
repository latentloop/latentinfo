export interface XDocument {
  type: 'x'
  collectedBy: 'x'
  url: string
  collectedAt: string
  tweetId: string
  text: string
  tweetAt: string
  tweetHour: number
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
  screenshot: string | null
  info?: {
    tags?: string[]
    x_tag_job_run?: number
    x_tag_job_fails?: number
    articleProcessed?: boolean
  }
}

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
  id: string  // document id: x:<statusId>
  collectedAt: string
  scrapeDate: string
  scrapeHour: number
  tweetHour: number
  hasScreenshot: boolean
  tags?: string[]
  articleProcessed?: boolean
}

// Item sent to frontend (with derived fields, without screenshot)
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
