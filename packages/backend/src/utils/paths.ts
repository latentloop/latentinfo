/**
 * Shared path utilities for home directory expansion and display shortening.
 */

import { homedir } from "node:os"
import { join } from "node:path"

const home = homedir()

/** Expand ~/... to absolute path using os.homedir(). Non-tilde paths returned unchanged. */
export function expandHome(path: string): string {
  if (!path) return path
  if (path === "~") return home
  if (path.startsWith("~/")) return join(home, path.slice(2))
  return path
}

/** Shorten absolute path for display: replace homedir prefix with ~. */
export function shortenHome(path: string): string {
  if (!path) return path
  if (path === home) return "~"
  if (path.startsWith(home + "/")) return "~" + path.slice(home.length)
  return path
}
