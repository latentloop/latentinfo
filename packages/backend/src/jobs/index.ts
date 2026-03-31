/**
 * Job registry.
 *
 * Statically imports and exports all job definitions.
 */

import type { JobDefinition } from "./types.js"
import xTagJob from "./x_tag/job.js"
import arxivDlJob from "./arxiv_dl/job.js"
import webClipMarkdownJob from "./web_clip_markdown/job.js"

const jobs: JobDefinition[] = [
  xTagJob,
  arxivDlJob,
  webClipMarkdownJob,
]

export default jobs
