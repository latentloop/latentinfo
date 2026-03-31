/**
 * Lightweight regex-based date parser.
 * Returns local date ranges for search filtering.
 */

export interface DateRange {
  from: Date
  to: Date
  /** Human-readable summary, e.g. "Mar 31, 2026" or "Mar 31 – Apr 1" */
  label: string
}

function startOfDay(d: Date): Date {
  const r = new Date(d)
  r.setHours(0, 0, 0, 0)
  return r
}

function endOfDay(d: Date): Date {
  const r = new Date(d)
  r.setHours(23, 59, 59, 999)
  return r
}

const shortDate = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
})

function formatLabel(from: Date, to: Date): string {
  const fromDay = startOfDay(from).getTime()
  const toDay = startOfDay(to).getTime()
  if (fromDay === toDay) {
    return shortDate.format(from)
  }
  const f = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" })
  return `${f.format(from)} – ${shortDate.format(to)}`
}

/**
 * Parse natural language text into a date range.
 * Returns null if the text cannot be interpreted as a date.
 *
 * Examples:
 *   "yesterday"    → { from: yesterday 00:00, to: yesterday 23:59 }
 *   "last week"    → { from: Mon 00:00, to: Sun 23:59 }
 *   "march 15"     → { from: Mar 15 00:00, to: Mar 15 23:59 }
 *   "3 days ago"   → { from: 3d ago 00:00, to: 3d ago 23:59 }
 */
/**
 * Year-month partial dates:
 *   "2026-03" / "2026/03" → month range (Mar 1 – Mar 31, 2026)
 *   "2026-3"  / "2026/3"  → same
 */
function tryPartialDate(text: string): DateRange | null {
  const m = text.match(/^(\d{4})[/-](\d{1,2})$/)
  if (!m) return null
  const year = parseInt(m[1]!, 10)
  const month = parseInt(m[2]!, 10)
  if (month < 1 || month > 12) return null
  const from = new Date(year, month - 1, 1)
  const to = new Date(year, month, 0) // last day of month
  return { from: startOfDay(from), to: endOfDay(to), label: formatLabel(from, to) }
}

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}

function singleDay(d: Date): DateRange {
  return { from: startOfDay(d), to: endOfDay(d), label: formatLabel(d, d) }
}

function monthRange(year: number, month: number): DateRange {
  const from = new Date(year, month, 1)
  const to = new Date(year, month + 1, 0) // last day of month
  return { from: startOfDay(from), to: endOfDay(to), label: formatLabel(from, to) }
}

export function parseDateRange(text: string): DateRange | null {
  const s = text.trim().toLowerCase()
  const today = new Date()
  let m: RegExpMatchArray | null

  // 1. Year-month partial: "2026-03" — delegate to existing helper
  const partial = tryPartialDate(text.trim())
  if (partial) return partial

  // 2. Keywords: yesterday / today / tomorrow
  if (s === "today") return singleDay(today)
  if (s === "yesterday") {
    const d = new Date(today); d.setDate(d.getDate() - 1); return singleDay(d)
  }
  if (s === "tomorrow") {
    const d = new Date(today); d.setDate(d.getDate() + 1); return singleDay(d)
  }

  // 3. Relative: "N days/weeks/months ago"
  m = s.match(/^(\d+)\s+(days?|weeks?|months?)\s+ago$/)
  if (m) {
    const n = parseInt(m[1]!, 10)
    const unit = m[2]!.replace(/s$/, "")
    const d = new Date(today)
    if (unit === "day") d.setDate(d.getDate() - n)
    else if (unit === "week") d.setDate(d.getDate() - n * 7)
    else if (unit === "month") d.setMonth(d.getMonth() - n)
    return singleDay(d)
  }

  // 4. "last week/month/year"
  m = s.match(/^last\s+(week|month|year)$/)
  if (m) {
    const unit = m[1]!
    if (unit === "week") {
      // Monday–Sunday of the previous week
      const dayOfWeek = today.getDay() // 0=Sun
      const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1
      const thisMonday = new Date(today)
      thisMonday.setDate(today.getDate() - mondayOffset)
      const from = new Date(thisMonday); from.setDate(from.getDate() - 7)
      const to = new Date(from); to.setDate(to.getDate() + 6)
      return { from: startOfDay(from), to: endOfDay(to), label: formatLabel(from, to) }
    }
    if (unit === "month") return monthRange(today.getFullYear(), today.getMonth() - 1)
    // year
    return {
      from: startOfDay(new Date(today.getFullYear() - 1, 0, 1)),
      to: endOfDay(new Date(today.getFullYear() - 1, 11, 31)),
      label: formatLabel(
        new Date(today.getFullYear() - 1, 0, 1),
        new Date(today.getFullYear() - 1, 11, 31),
      ),
    }
  }

  // 5. "next week/month"
  m = s.match(/^next\s+(week|month)$/)
  if (m) {
    const unit = m[1]!
    if (unit === "week") {
      const dayOfWeek = today.getDay()
      const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1
      const thisMonday = new Date(today)
      thisMonday.setDate(today.getDate() - mondayOffset)
      const from = new Date(thisMonday); from.setDate(from.getDate() + 7)
      const to = new Date(from); to.setDate(to.getDate() + 6)
      return { from: startOfDay(from), to: endOfDay(to), label: formatLabel(from, to) }
    }
    // month
    return monthRange(today.getFullYear(), today.getMonth() + 1)
  }

  // 6. ISO date: "2026-03-15"
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (m) {
    const d = new Date(parseInt(m[1]!, 10), parseInt(m[2]!, 10) - 1, parseInt(m[3]!, 10))
    return singleDay(d)
  }

  // 7. Month + day [+ year]: "march 15", "march 15 2026"
  m = s.match(/^([a-z]+)\s+(\d{1,2})(?:\s+(\d{4}))?$/)
  if (m && MONTHS[m[1]!] !== undefined) {
    const mo = MONTHS[m[1]!]!
    const day = parseInt(m[2]!, 10)
    const year = m[3] ? parseInt(m[3], 10) : today.getFullYear()
    return singleDay(new Date(year, mo, day))
  }

  // 8. Bare month [+ year]: "march", "march 2026"
  m = s.match(/^([a-z]+)(?:\s+(\d{4}))?$/)
  if (m && MONTHS[m[1]!] !== undefined) {
    const mo = MONTHS[m[1]!]!
    const year = m[2] ? parseInt(m[2], 10) : today.getFullYear()
    return monthRange(year, mo)
  }

  return null
}
