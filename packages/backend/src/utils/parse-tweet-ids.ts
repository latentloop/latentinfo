/**
 * Fuzzy-parse tweet IDs from mixed user input.
 *
 * Accepts:
 * - Full URLs: https://x.com/user/status/123456, https://twitter.com/user/status/123456
 * - Bare numeric IDs: 123456789
 * - Whitespace, newline, or comma separated
 * - Ignores empty lines and non-matching text
 *
 * Returns deduplicated array of bare numeric tweet ID strings.
 */
export function parseTweetIds(input: string): string[] {
  const ids = new Set<string>()
  const lines = input.split(/[\n,]+/)

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // Try to extract from URL: /status/<digits>
    const urlMatch = trimmed.match(/\/status\/(\d+)/)
    if (urlMatch) {
      ids.add(urlMatch[1]!)
      continue
    }

    // Try bare numeric ID
    const bareMatch = trimmed.match(/^(\d{4,})$/)
    if (bareMatch) {
      ids.add(bareMatch[1]!)
      continue
    }

    // Also handle whitespace-separated tokens on the same line
    for (const token of trimmed.split(/\s+/)) {
      const tokenUrlMatch = token.match(/\/status\/(\d+)/)
      if (tokenUrlMatch) {
        ids.add(tokenUrlMatch[1]!)
        continue
      }
      const tokenBareMatch = token.match(/^(\d{4,})$/)
      if (tokenBareMatch) {
        ids.add(tokenBareMatch[1]!)
      }
    }
  }

  return [...ids]
}
