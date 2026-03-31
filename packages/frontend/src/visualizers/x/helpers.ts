import type { XItem } from "./types"

const numberFormatter = new Intl.NumberFormat()
export function formatCount(n: number): string {
  return numberFormatter.format(Number(n) || 0)
}

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
})

export function formatTime(dateStr: string): string {
  if (!dateStr) return "\u2014"
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return dateStr
  return timeFormatter.format(d)
}

export function toLocalDateStr(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

export function getDateStr(item: XItem, dateMode: string): string | null {
  if (dateMode === "scrape_date") {
    if (item.info.collectedAt) return toLocalDateStr(new Date(item.info.collectedAt))
    return null
  }
  if (!item.rawData.tweetAt) return null
  return toLocalDateStr(new Date(item.rawData.tweetAt))
}

export function hourTo4hGroup(h: number): string {
  if (h < 4) return "00\u201304"
  if (h < 8) return "04\u201308"
  if (h < 12) return "08\u201312"
  if (h < 16) return "12\u201316"
  if (h < 20) return "16\u201320"
  return "20\u201324"
}

export function getHourGroup(item: XItem, dateMode: string): string {
  if (dateMode === "scrape_date") {
    if (item.info.collectedAt) {
      try {
        return hourTo4hGroup(new Date(item.info.collectedAt).getHours())
      } catch {
        // fall through
      }
    }
    return hourTo4hGroup(typeof item.info.scrapeHour === "number" ? item.info.scrapeHour : 0)
  }
  if (item.rawData.tweetAt) {
    try {
      return hourTo4hGroup(new Date(item.rawData.tweetAt).getHours())
    } catch {
      // fall through
    }
  }
  return hourTo4hGroup(typeof item.info.tweetHour === "number" ? item.info.tweetHour : 0)
}

/** Extract handle from URL: "https://x.com/user/status/123" -> "user" */
export function getHandleFromUrl(url: string): string {
  if (!url) return ""
  const m = url.match(/(?:x\.com|twitter\.com)\/([^/]+)\/status\//)
  return m ? m[1].toLowerCase() : ""
}

/** Extract status ID from URL as BigInt-safe string */
export function getStatusId(url: string): string {
  if (!url) return ""
  const m = url.match(/\/status\/(\d+)/)
  return m ? m[1] : ""
}

const PALETTE = [
  "#58a6ff", "#f78166", "#d2a8ff", "#7ee787", "#ffa657",
  "#ff7b72", "#79c0ff", "#a5d6ff", "#d29922", "#56d364",
  "#bc8cff", "#f2cc60", "#ff9bce", "#76e3ea", "#ffc680",
]

const GROUP_COLORS: Record<string, string> = {}

export function getGroupColor(group: string): string {
  if (!GROUP_COLORS[group]) {
    const idx = Object.keys(GROUP_COLORS).length % PALETTE.length
    GROUP_COLORS[group] = PALETTE[idx]
  }
  return GROUP_COLORS[group]
}

export interface ThreadItem {
  item: XItem
  children: XItem[]
}

/**
 * Organize items into threads. Detects two kinds:
 * 1. Explicit parentTweetUrl relationships (replies)
 * 2. Self-threads: same author, consecutive status IDs, posted within 30 min
 */
export function threadPosts(items: XItem[], dateMode = "scrape_date"): ThreadItem[] {
  const byUrl = new Map<string, XItem>()
  for (const t of items) byUrl.set(t.rawData.url, t)

  const childOf = new Map<string, string>() // child url -> parent url

  // 1. Explicit parent relationships
  for (const t of items) {
    if (t.rawData.parentTweetUrl && byUrl.has(t.rawData.parentTweetUrl)) {
      childOf.set(t.rawData.url, t.rawData.parentTweetUrl)
    }
  }

  // 2. Detect self-threads
  const byAuthor = new Map<string, XItem[]>()
  for (const t of items) {
    const handle = getHandleFromUrl(t.rawData.url)
    if (!handle) continue
    if (!byAuthor.has(handle)) byAuthor.set(handle, [])
    byAuthor.get(handle)!.push(t)
  }

  for (const [, authorItems] of byAuthor) {
    if (authorItems.length < 2) continue
    authorItems.sort((a, b) => {
      const idA = getStatusId(a.rawData.url)
      const idB = getStatusId(b.rawData.url)
      return idA.localeCompare(idB, undefined, { numeric: true })
    })
    for (let i = 1; i < authorItems.length; i++) {
      const prev = authorItems[i - 1]
      const curr = authorItems[i]
      if (childOf.has(curr.rawData.url)) continue
      const tPrev = new Date(prev.rawData.tweetAt || (0 as any)).getTime()
      const tCurr = new Date(curr.rawData.tweetAt || (0 as any)).getTime()
      if (Math.abs(tCurr - tPrev) < 30 * 60 * 1000) {
        childOf.set(curr.rawData.url, prev.rawData.url)
      }
    }
  }

  // Flatten chains to root
  function findRoot(url: string): string {
    const visited = new Set<string>()
    let current = url
    while (childOf.has(current) && !visited.has(current)) {
      visited.add(current)
      current = childOf.get(current)!
    }
    return current
  }

  const childrenMap = new Map<string, XItem[]>()
  const rootOf = new Map<string, string>()
  for (const [childUrl] of childOf) {
    const root = findRoot(childUrl)
    rootOf.set(childUrl, root)
    if (!childrenMap.has(root)) childrenMap.set(root, [])
    childrenMap.get(root)!.push(byUrl.get(childUrl)!)
  }
  for (const [childUrl, root] of rootOf) {
    childOf.set(childUrl, root)
  }

  // Sort children chronologically
  for (const [, children] of childrenMap) {
    children.sort((a, b) => {
      const idA = getStatusId(a.rawData.url)
      const idB = getStatusId(b.rawData.url)
      return idA.localeCompare(idB, undefined, { numeric: true })
    })
  }

  // Build threaded list
  const emitted = new Set<string>()
  const result: ThreadItem[] = []
  for (const t of items) {
    if (emitted.has(t.rawData.url)) continue

    if (childOf.has(t.rawData.url)) {
      const parentUrl = childOf.get(t.rawData.url)!
      if (!emitted.has(parentUrl)) {
        const parent = byUrl.get(parentUrl)!
        const children = childrenMap.get(parentUrl) || []
        result.push({ item: parent, children })
        emitted.add(parentUrl)
        for (const c of children) emitted.add(c.rawData.url)
      }
    } else if (childrenMap.has(t.rawData.url)) {
      const children = childrenMap.get(t.rawData.url) || []
      result.push({ item: t, children })
      emitted.add(t.rawData.url)
      for (const c of children) emitted.add(c.rawData.url)
    } else {
      result.push({ item: t, children: [] })
      emitted.add(t.rawData.url)
    }
  }

  // Sort threads by parent tweet's datetime (newest first)
  result.sort((a, b) => {
    const ta = dateMode === "scrape_date"
      ? new Date(a.item.info.collectedAt || 0).getTime()
      : new Date(a.item.rawData.tweetAt || 0).getTime()
    const tb = dateMode === "scrape_date"
      ? new Date(b.item.info.collectedAt || 0).getTime()
      : new Date(b.item.rawData.tweetAt || 0).getTime()
    return tb - ta
  })

  return result
}

export interface DateSection {
  date: string
  groups: { name: string; items: ThreadItem[] }[]
  total: number
}

export function buildDateSections(
  items: XItem[],
  dateMode: string,
): DateSection[] {
  // Build parent lookup so children follow their parent's date
  const byUrl = new Map<string, XItem>()
  for (const t of items) byUrl.set(t.rawData.url, t)

  const byDate: Record<string, XItem[]> = {}
  for (const t of items) {
    // If this tweet has a parent in our dataset, use the parent's date
    let dateItem = t
    if (t.rawData.parentTweetUrl && byUrl.has(t.rawData.parentTweetUrl)) {
      dateItem = byUrl.get(t.rawData.parentTweetUrl)!
    }
    const d = getDateStr(dateItem, dateMode)
    if (d === null) continue // skip promoted/ad tweets without dates
    if (!byDate[d]) byDate[d] = []
    byDate[d].push(t)
  }

  const dates = Object.keys(byDate).sort().reverse()

  return dates.map((date) => {
    // Thread first across all items in this date, then group by parent's hour
    const threads = threadPosts(byDate[date], dateMode)

    // Group threads by the parent item's hour group
    const groups: Record<string, ThreadItem[]> = {}
    for (const thread of threads) {
      const g = getHourGroup(thread.item, dateMode)
      if (!groups[g]) groups[g] = []
      groups[g].push(thread)
    }

    const sortedGroups = Object.entries(groups)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([name, threadItems]) => ({
        name,
        items: threadItems,
      }))

    return { date, groups: sortedGroups, total: byDate[date].length }
  })
}
