import type { Client } from "@libsql/client"

export interface DocumentBase {
  type: string
  url: string
  collectedAt: string
  collectedBy: string
}

export interface XDocument extends DocumentBase {
  type: 'x'
  collectedBy: 'x'
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
  screenshot: string | null
  info?: {
    tags?: string[]
    x_tag_job_run?: number
    x_tag_job_fails?: number
  }
}

export type { Client }
