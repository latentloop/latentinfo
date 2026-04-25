/**
 * GitHub visualizer helpers — date grouping mirroring arxiv visualizer.
 */

import type { GithubItem } from "./types"

const numberFormatter = new Intl.NumberFormat()
export function formatCount(n: number): string {
  return numberFormatter.format(Number(n) || 0)
}

function toLocalDateStr(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

export function getDateStr(item: GithubItem): string | null {
  if (!item.info.collectedAt) return null
  return toLocalDateStr(new Date(item.info.collectedAt))
}

function hourTo4hGroup(h: number): string {
  if (h < 4) return "00-04"
  if (h < 8) return "04-08"
  if (h < 12) return "08-12"
  if (h < 16) return "12-16"
  if (h < 20) return "16-20"
  return "20-24"
}

export function getHourGroup(item: GithubItem): string {
  if (item.info.collectedAt) {
    try {
      return hourTo4hGroup(new Date(item.info.collectedAt).getHours())
    } catch {
      // fall through
    }
  }
  return hourTo4hGroup(0)
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
    GROUP_COLORS[group] = PALETTE[idx]!
  }
  return GROUP_COLORS[group]!
}

export interface DateSection {
  date: string
  groups: { name: string; items: GithubItem[] }[]
  total: number
}

export function buildDateSections(items: GithubItem[]): DateSection[] {
  const byDate: Record<string, GithubItem[]> = {}
  for (const item of items) {
    const d = getDateStr(item)
    if (d === null) continue
    if (!byDate[d]) byDate[d] = []
    byDate[d]!.push(item)
  }

  const dates = Object.keys(byDate).sort().reverse()

  return dates.map((date) => {
    const dateItems = byDate[date]!
    dateItems.sort((a, b) => {
      const ta = new Date(a.info.collectedAt || 0).getTime()
      const tb = new Date(b.info.collectedAt || 0).getTime()
      return tb - ta
    })

    const groups: Record<string, GithubItem[]> = {}
    for (const item of dateItems) {
      const g = getHourGroup(item)
      if (!groups[g]) groups[g] = []
      groups[g]!.push(item)
    }

    const sortedGroups = Object.entries(groups)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([name, groupItems]) => ({ name, items: groupItems }))

    return { date, groups: sortedGroups, total: dateItems.length }
  })
}
