/**
 * GitHub collector definition.
 *
 * Matches GitHub repository pages and stores repository README data.
 */

import type { CollectorDefinition } from "../../collector-runner.js"
import { createPageHandler } from "./cdp-handler.js"

const githubCollector: CollectorDefinition = {
  id: "github",
  description: "Save GitHub repositories",

  urlPatterns: [
    "https://github.com/*/*",
  ],

  pageHandler(page, db) {
    createPageHandler(page, db)
  },
}

export default githubCollector
