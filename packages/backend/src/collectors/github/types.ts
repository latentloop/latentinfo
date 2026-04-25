export interface GithubReadmeImage {
  originalUrl: string
  resolvedUrl: string
  dataUri: string
}

export interface GithubDocument {
  type: "github"
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
  htmlUrl: string
  rawUrl: string
  url: string
  collectedAt: string
  collectedBy: "github"
}
