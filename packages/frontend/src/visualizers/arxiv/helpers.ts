/**
 * Arxiv visualizer helpers — date grouping mirroring x visualizer.
 * No threading — papers are standalone items.
 */

import type { ArxivItem } from "./types"

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

function toLocalDateStr(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

export function getDateStr(item: ArxivItem, dateMode: string): string | null {
  if (dateMode === "scrape_date") {
    if (item.info.collectedAt) return toLocalDateStr(new Date(item.info.collectedAt))
    return null
  }
  if (!item.rawData.submittedAt) return null
  return toLocalDateStr(new Date(item.rawData.submittedAt))
}

function hourTo4hGroup(h: number): string {
  if (h < 4) return "00\u201304"
  if (h < 8) return "04\u201308"
  if (h < 12) return "08\u201312"
  if (h < 16) return "12\u201316"
  if (h < 20) return "16\u201320"
  return "20\u201324"
}

export function getHourGroup(item: ArxivItem, dateMode: string): string {
  const dateStr = dateMode === "scrape_date" ? item.info.collectedAt : item.rawData.submittedAt
  if (dateStr) {
    try {
      return hourTo4hGroup(new Date(dateStr).getHours())
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
  groups: { name: string; items: ArxivItem[] }[]
  total: number
}

export function buildDateSections(
  items: ArxivItem[],
  dateMode: string,
): DateSection[] {
  const byDate: Record<string, ArxivItem[]> = {}
  for (const item of items) {
    const d = getDateStr(item, dateMode)
    if (d === null) continue
    if (!byDate[d]) byDate[d] = []
    byDate[d]!.push(item)
  }

  const dates = Object.keys(byDate).sort().reverse()

  return dates.map((date) => {
    const dateItems = byDate[date]!

    // Sort items within each date by their date field (newest first)
    dateItems.sort((a, b) => {
      const ta = dateMode === "scrape_date"
        ? new Date(a.info.collectedAt || 0).getTime()
        : new Date(a.rawData.submittedAt || 0).getTime()
      const tb = dateMode === "scrape_date"
        ? new Date(b.info.collectedAt || 0).getTime()
        : new Date(b.rawData.submittedAt || 0).getTime()
      return tb - ta
    })

    // Group by hour
    const groups: Record<string, ArxivItem[]> = {}
    for (const item of dateItems) {
      const g = getHourGroup(item, dateMode)
      if (!groups[g]) groups[g] = []
      groups[g]!.push(item)
    }

    const sortedGroups = Object.entries(groups)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([name, groupItems]) => ({ name, items: groupItems }))

    return { date, groups: sortedGroups, total: dateItems.length }
  })
}
