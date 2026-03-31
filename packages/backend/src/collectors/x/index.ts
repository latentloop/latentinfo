/**
 * X/Twitter collector definition.
 *
 * Matches x.com feed/profile/status pages.
 * - pageHandler: scrapes tweets (text, images, metadata, screenshots)
 * - actionHandler: floating panel with skip button
 */

import type { CollectorDefinition } from "../../collector-runner.js"
import { createPageHandler } from "./cdp-handler.js"
import { createActionHandler } from "./action.js"

const xCollector: CollectorDefinition = {
  id: "x",
  description: "Save tweets",

  urlPatterns: [
    "https://x.com/*",
  ],

  pageHandler(page, db) {
    createPageHandler(page, db)
  },

  actionHandler(page, db) {
    createActionHandler(page, db)
  },
}

export default xCollector
