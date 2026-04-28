import test from "node:test"
import assert from "node:assert/strict"

import type { GithubDocument } from "./types.js"
import { __test__ } from "./cdp-handler.js"

const rawReadme = {
  owner: "openai",
  repo: "example",
  fullName: "openai/example",
  description: "Example repo",
  defaultBranch: "main",
  stars: 42,
  forks: 7,
  language: "TypeScript",
  readmePath: "README.md",
  readmeSha: "abc123",
  readmeMarkdown: "# Example\n",
  readmeText: "Example",
  imageUrls: ["https://raw.githubusercontent.com/openai/example/main/logo.png"],
  htmlUrl: "https://github.com/openai/example/blob/main/README.md",
  rawUrl: "https://raw.githubusercontent.com/openai/example/main/README.md",
  url: "https://github.com/openai/example",
}

const existingReadme: GithubDocument = {
  type: "github",
  ...rawReadme,
  readmeImages: [],
  collectedAt: "2026-04-25T20:00:00.000Z",
  collectedBy: "github",
}

test("github dedupe ignores missing image backfill when README and repo info are unchanged", () => {
  assert.equal(__test__.hasGithubInfoChanged(existingReadme, rawReadme), false)
})

test("github dedupe falls back to markdown when a README SHA is unavailable", () => {
  assert.equal(__test__.isSameReadme(existingReadme, {
    ...rawReadme,
    readmeSha: "",
  }), true)
})

test("github dedupe detects README and repo metadata changes", () => {
  assert.equal(__test__.hasGithubInfoChanged(existingReadme, {
    ...rawReadme,
    readmeSha: "def456",
    readmeMarkdown: "# Updated\n",
  }), true)

  assert.equal(__test__.hasGithubInfoChanged(existingReadme, {
    ...rawReadme,
    stars: 43,
  }), true)
})
