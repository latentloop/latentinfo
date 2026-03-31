/**
 * Parse arxiv IDs from mixed user input.
 *
 * Accepts:
 * - Full URLs: https://arxiv.org/abs/2301.07041, https://arxiv.org/pdf/2301.07041v2
 * - Bare IDs: 2301.07041, hep-th/9901001
 * - Version suffixes stripped automatically (v1, v2, etc.)
 * - Whitespace, newline, or comma separated
 * - Ignores empty lines and non-matching text
 *
 * Returns deduplicated array of bare arxiv ID strings.
 */

/** Extract a bare arxiv ID from a single input string. Strips version suffix. */
export function parseArxivId(input: string): string | null {
  let id = input.trim()

  // Handle URLs: https://arxiv.org/abs/2301.07041v2, https://arxiv.org/pdf/2301.07041
  const urlMatch = id.match(/arxiv\.org\/(?:abs|pdf|e-print)\/([^\s?#]+)/)
  if (urlMatch) id = urlMatch[1]!

  // Strip version suffix (v1, v2, etc.)
  id = id.replace(/v\d+$/, "")

  // Validate: new format (YYMM.NNNNN) or old format (category/NNNNNNN)
  if (/^\d{4}\.\d{4,5}$/.test(id) || /^[a-z-]+\/\d{7}$/.test(id)) {
    return id
  }
  return null
}

/** Parse multiple arxiv IDs from multi-line/comma-separated input. */
export function parseArxivIds(input: string): string[] {
  const ids = new Set<string>()
  const lines = input.split(/[\n,]+/)

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const parsed = parseArxivId(trimmed)
    if (parsed) {
      ids.add(parsed)
      continue
    }

    // Also handle whitespace-separated tokens on the same line
    for (const token of trimmed.split(/\s+/)) {
      const tokenParsed = parseArxivId(token)
      if (tokenParsed) {
        ids.add(tokenParsed)
      }
    }
  }

  return [...ids]
}
