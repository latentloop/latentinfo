import type { VisualizerDefinition } from "../../server.js"
import { handleArxivApi } from "./handlers.js"

export const arxivVisualizer: VisualizerDefinition = {
  id: "arxiv",
  label: "arXiv",
  handleApi: handleArxivApi,
}
