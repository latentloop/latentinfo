/**
 * Web Clipper collector definition.
 *
 * Matches all pages (urlPatterns: ["*"]).
 * - actionHandler: clip button in panel → selection UI → store in SQLite
 * - pageHandler: auto-detect rules (x_article, etc.)
 */

import type { CollectorDefinition } from "../../collector-runner.js"
import { createActionHandler } from "./action.js"
import { createPageHandler } from "./auto-detect.js"

const webClipperCollector: CollectorDefinition = {
  id: "web_clip",
  description: "Clip web content for reading",

  urlPatterns: [
    "*",
  ],

  actionHandler(page, db) {
    createActionHandler(page, db)
  },

  pageHandler(page, _db) {
    createPageHandler(page)
  },
}

export default webClipperCollector
