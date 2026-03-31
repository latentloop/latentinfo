import type { VisualizerDefinition } from "../../server.js"
import { handleXApi } from "./handlers.js"

export const xVisualizer: VisualizerDefinition = {
  id: "x",
  label: "Data",
  handleApi: handleXApi,
}
