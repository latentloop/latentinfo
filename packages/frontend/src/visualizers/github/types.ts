export interface GithubReadmeImage {
  originalUrl: string
  resolvedUrl: string
  dataUri: string
}

export interface GithubRawData {
  owner: string
  repo: string
  fullName: string
  description: string
  defaultBranch: string
  stars: number
  forks: number
  language: string
  readmePath: string
  readmeSha: string
  readmeMarkdown: string
  readmeText: string
  readmeImages: GithubReadmeImage[]
  readmeImagesLoaded?: boolean
  readmeLength?: number
  readmeTruncated?: boolean
  htmlUrl: string
  rawUrl: string
  url: string
}

export interface GithubInfo {
  id: string
  collectedAt: string
}

export interface GithubItem {
  rawData: GithubRawData
  info: GithubInfo
}

export interface GithubListResponse {
  items: GithubItem[]
  total: number
  offset: number
  limit: number
}
