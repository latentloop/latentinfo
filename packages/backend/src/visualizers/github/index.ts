import type { VisualizerDefinition } from "../../server.js"
import { handleGithubApi } from "./handlers.js"

export const githubVisualizer: VisualizerDefinition = {
  id: "github",
  label: "GitHub",
  handleApi: handleGithubApi,
}

