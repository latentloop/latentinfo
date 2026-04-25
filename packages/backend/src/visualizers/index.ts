import { xVisualizer } from "./x/index.js"
import { arxivVisualizer } from "./arxiv/index.js"
import { githubVisualizer } from "./github/index.js"
import type { VisualizerDefinition } from "../server.js"

export type { VisualizerDefinition }

export const visualizers: VisualizerDefinition[] = [
  xVisualizer,
  arxivVisualizer,
  githubVisualizer,
]
