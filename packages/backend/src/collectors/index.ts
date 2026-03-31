/**
 * Collector registry.
 *
 * Statically imports and exports all collector definitions.
 */

import type { CollectorDefinition } from "../collector-runner.js"
import xCollector from "./x/index.js"
import arxivCollector from "./arxiv/index.js"
import webClipperCollector from "./web_clipper/index.js"

const collectors: CollectorDefinition[] = [
  xCollector,
  arxivCollector,
  webClipperCollector,
]

export default collectors
