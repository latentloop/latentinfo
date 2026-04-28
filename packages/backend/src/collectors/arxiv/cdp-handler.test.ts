import test from "node:test"
import assert from "node:assert/strict"

import type { ArxivDocument } from "./types.js"
import { __test__ } from "./cdp-handler.js"

const rawPaper = {
  arxivId: "2604.15039",
  title: "A Test Paper",
  authors: ["Ada Lovelace", "Grace Hopper"],
  abstract: "A useful abstract.",
  categories: ["cs.AI"],
  submittedAt: "2026-04-20T00:00:00.000Z",
  pdfUrl: "https://arxiv.org/pdf/2604.15039",
  url: "https://arxiv.org/abs/2604.15039v1",
  versions: [{ version: "v1", date: "2026-04-20T00:00:00.000Z", size: "123 KB" }],
}

const existingPaper: ArxivDocument = {
  ...rawPaper,
  url: "https://arxiv.org/abs/2604.15039",
  collectedAt: "2026-04-25T20:00:00.000Z",
  collectedBy: "arxiv",
}

test("arxiv dedupe ignores URL-only differences for the same paper", () => {
  assert.equal(__test__.hasPaperInfoChanged(existingPaper, rawPaper), false)
})

test("arxiv dedupe detects metadata and version changes", () => {
  assert.equal(__test__.hasPaperInfoChanged(existingPaper, {
    ...rawPaper,
    title: "A Changed Test Paper",
  }), true)

  assert.equal(__test__.hasPaperInfoChanged(existingPaper, {
    ...rawPaper,
    versions: [
      ...rawPaper.versions,
      { version: "v2", date: "2026-04-21T00:00:00.000Z", size: "125 KB" },
    ],
  }), true)
})
