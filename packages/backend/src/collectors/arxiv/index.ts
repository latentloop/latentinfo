/**
 * arxiv collector definition.
 *
 * Matches arxiv.org abstract pages and scrapes paper metadata.
 */

import type { CollectorDefinition } from "../../collector-runner.js"
import { createPageHandler } from "./cdp-handler.js"

const arxivCollector: CollectorDefinition = {
  id: "arxiv",
  description: "Save arxiv papers",

  urlPatterns: [
    "https://arxiv.org/abs/*",
  ],

  pageHandler(page, db) {
    createPageHandler(page, db)
  },
}

export default arxivCollector
