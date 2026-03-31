/**
 * ArxivPage — displays collected arxiv papers in date-grouped, hour-column grid.
 * Mirrors XPage structure: SearchBar tokens, Order By, date sections, group columns.
 */

import { useState, useCallback, useEffect, useRef, useMemo, memo } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { PaperCard } from "./paper-card"
import { buildDateSections, getGroupColor, formatCount } from "./helpers"
import type { ArxivItem, ArxivListResponse } from "./types"
import type { DateSection } from "./helpers"
import { SourceSelector, type DataSource } from "@/components/source-selector"
import { FilterBar, type FilterToken, type FilterCategory } from "@/components/filter-bar"
import { parseDateRange } from "@/lib/date-parser"

type ArxivTokenType = "text" | "user" | "content_date" | "collect_date"

const CATEGORIES: readonly FilterCategory<ArxivTokenType>[] = [
  { type: "text", label: "Text", hint: "paper content" },
  { type: "user", label: "User", hint: "author name" },
  { type: "content_date", label: "Content Date", hint: "yesterday, march 15, 2026-03" },
  { type: "collect_date", label: "Collect Date", hint: "3 days ago, last week" },
] as const
const DATE_TYPES = new Set(["content_date", "collect_date"] as const)

const PAGE_SIZE = 1000
const SSE_DEBOUNCE_MS = 500

export function ArxivPage({ dataSource, onDataSourceChange }: { dataSource: DataSource; onDataSourceChange: (v: DataSource) => void }) {
  const [items, setItems] = useState<ArxivItem[]>([])
  const [total, setTotal] = useState(0)
  const [totalUnfiltered, setTotalUnfiltered] = useState(0)
  const [tokens, setTokens] = useState<FilterToken[]>([])
  const tokensRef = useRef(tokens)
  tokensRef.current = tokens
  const [liveText, setLiveText] = useState("")
  const liveTextRef = useRef(liveText)
  liveTextRef.current = liveText
  const [dateMode, setDateMode] = useState(
    () => (typeof localStorage !== "undefined" && localStorage.getItem("arxiv_dateMode")) || "scrape_date",
  )
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const fetchGenRef = useRef(0)
  const [dateWindowDays, setDateWindowDays] = useState(3)
  const [hasMore, setHasMore] = useState(true)

  function buildFilterParams(toks: FilterToken[], live: string): { q: string; user?: string; dateField?: string; dateFrom?: string; dateTo?: string } {
    const textParts: string[] = []
    let user: string | undefined
    let dateField: string | undefined
    let dateFrom: string | undefined
    let dateTo: string | undefined
    for (const t of toks) {
      if (t.type === "text") {
        textParts.push(t.value)
      } else if (t.type === "user") {
        user = t.value
      } else if (t.type === "content_date" && t.dateFrom && t.dateTo) {
        dateField = "submittedAt"
        dateFrom = t.dateFrom
        dateTo = t.dateTo
      } else if (t.type === "collect_date" && t.dateFrom && t.dateTo) {
        dateField = "collectedAt"
        dateFrom = t.dateFrom
        dateTo = t.dateTo
      }
    }
    if (live.trim()) textParts.push(live.trim())
    return { q: textParts.join(" "), user, dateField, dateFrom, dateTo }
  }

  const fetchAll = useCallback(
    async (dm: string, filterTokens: FilterToken[], live: string, isPoll = false) => {
      const gen = ++fetchGenRef.current
      if (!isPoll) setLoading(true)
      setError(null)

      const { q, user, dateField: filterDateField, dateFrom: filterDateFrom, dateTo: filterDateTo } = buildFilterParams(filterTokens, live)

      try {
        const params = new URLSearchParams({
          offset: "0",
          limit: String(PAGE_SIZE),
          sort: "desc",
          sortField: dm === "scrape_date" ? "collectedAt" : "submittedAt",
          q,
        })
        if (user) params.set("user", user)
        // Apply date window when no explicit date filter is set
        if (filterDateField && filterDateFrom && filterDateTo) {
          params.set("dateField", filterDateField)
          params.set("dateFrom", filterDateFrom)
          params.set("dateTo", filterDateTo)
        } else {
          const windowDateFrom = new Date(Date.now() - dateWindowDays * 86400_000).toISOString()
          params.set("dateField", dm === "scrape_date" ? "collectedAt" : "submittedAt")
          params.set("dateFrom", windowDateFrom)
        }
        const resp = await fetch(`/api/v1/arxiv?${params}`)
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        const data: ArxivListResponse = await resp.json()
        if (gen !== fetchGenRef.current) return
        setItems(data.items)
        setTotal(data.total)
        if (!q && !user && !filterDateField) setTotalUnfiltered(data.total)

        // If we loaded nothing, there's nothing more to fetch
        if (data.items.length === 0) {
          setHasMore(false)
        }
      } catch (err: any) {
        if (gen !== fetchGenRef.current) return
        setError(err?.message || "Failed to load papers")
      } finally {
        if (gen === fetchGenRef.current) setLoading(false)
      }
    },
    [dateWindowDays],
  )

  useEffect(() => {
    fetchAll(dateMode, tokens, liveText)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let sseDebounce: ReturnType<typeof setTimeout> | null = null
    const handleSse = () => {
      if (sseDebounce) clearTimeout(sseDebounce)
      sseDebounce = setTimeout(() => {
        fetchAll(dateMode, tokensRef.current, liveTextRef.current, true)
      }, SSE_DEBOUNCE_MS)
    }
    window.addEventListener("sse:data-changed", handleSse)
    return () => { window.removeEventListener("sse:data-changed", handleSse); if (sseDebounce) clearTimeout(sseDebounce) }
  }, [fetchAll, dateMode])

  const handleDateModeChange = useCallback(
    (mode: string) => {
      setDateMode(mode)
      setHasMore(true)
      if (typeof localStorage !== "undefined") localStorage.setItem("arxiv_dateMode", mode)
      fetchAll(mode, tokensRef.current, liveTextRef.current)
    },
    [fetchAll],
  )

  const handleTokensChange = useCallback(
    (newTokens: FilterToken[]) => {
      setTokens(newTokens)
      tokensRef.current = newTokens
      setHasMore(true)
      fetchAll(dateMode, newTokens, liveTextRef.current)
    },
    [fetchAll, dateMode],
  )

  const liveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleLiveText = useCallback(
    (text: string) => {
      setLiveText(text)
      liveTextRef.current = text
      if (liveTimerRef.current) clearTimeout(liveTimerRef.current)
      liveTimerRef.current = setTimeout(() => {
        fetchAll(dateMode, tokensRef.current, text)
      }, 200)
    },
    [fetchAll, dateMode],
  )

  // Load more papers (expand date window by 3 days)
  const handleLoadMore = useCallback(() => {
    setDateWindowDays((prev) => prev + 3)
    setHasMore(true)
  }, [])

  // Re-fetch when dateWindowDays changes (load more)
  useEffect(() => {
    if (dateWindowDays > 3) {
      fetchAll(dateMode, tokensRef.current, liveTextRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateWindowDays])

  const sections = useMemo(
    () => (items.length === 0 ? [] : buildDateSections(items, dateMode)),
    [items, dateMode],
  )

  // ── Section-level virtualizer ──
  const scrollAreaRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: sections.length,
    getScrollElement: () => scrollAreaRef.current,
    getItemKey: (index) => sections[index]?.date ?? index,
    estimateSize: () => 40 + 620 + 32,
    overscan: 2,
  })

  // Auto-load more when scrolled near bottom
  const virtualItems = virtualizer.getVirtualItems()
  const lastItem = virtualItems[virtualItems.length - 1]
  useEffect(() => {
    if (!lastItem) return
    if (lastItem.index >= sections.length - 3 && hasMore && !loading && !buildFilterParams(tokens, liveText).dateField) {
      handleLoadMore()
    }
  }, [lastItem?.index, sections.length, hasMore, loading, tokens, liveText, handleLoadMore])

  const displayTotal = totalUnfiltered || total
  const hasFilters = tokens.length > 0 || liveText.trim().length > 0

  return (
    <div className="flex flex-col h-full x-theme">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-border bg-muted px-4 py-1.5">
        <div className="flex items-center gap-1.5">
          <SourceSelector value={dataSource} onChange={onDataSourceChange} />
          <div className="flex-1" />
          {error ? (
            <Badge variant="destructive" title={error} className="text-[11px] px-1.5 py-0">
              Load error
            </Badge>
          ) : displayTotal > 0 ? (
            <Badge variant="secondary" className="whitespace-nowrap text-[11px] px-1.5 py-0">
              {hasFilters
                ? formatCount(total) + " / " + formatCount(displayTotal)
                : formatCount(displayTotal)}{" "}
              papers
            </Badge>
          ) : null}

          <FilterBar
            categories={CATEGORIES}
            tokens={tokens}
            onTokensChange={handleTokensChange}
            onLiveText={handleLiveText}
            dateTypes={DATE_TYPES}
            inputId="searchInput-data"
            placeholder="Filter papers..."
            className="min-w-[200px]"
            style={{ width: 280 }}
          />

          <span className="text-[11px] text-muted-foreground whitespace-nowrap">Order:</span>
          <Select value={dateMode} onValueChange={handleDateModeChange}>
            <SelectTrigger className="w-[110px] h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="post_date">Submit Date</SelectItem>
              <SelectItem value="scrape_date">Collect Date</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </header>

      {/* Content */}
      <div ref={scrollAreaRef} className="flex-1 overflow-y-auto">
        {error && items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <h2 className="text-lg font-semibold text-foreground mb-2">Failed to load papers</h2>
            <p className="text-sm text-muted-foreground">{error}</p>
          </div>
        ) : items.length === 0 && loading ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="text-sm text-muted-foreground animate-pulse">Loading...</div>
          </div>
        ) : items.length === 0 && !loading ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <h2 className="text-lg font-semibold text-foreground mb-2">No papers found</h2>
            <p className="text-sm text-muted-foreground">
              {tokens.length > 0 ? "Try different filters." : "Browse arxiv.org with the connected browser to collect papers."}
            </p>
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const section = sections[virtualRow.index]
              if (!section) return null
              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {virtualRow.index > 0 && (
                    <div className="flex items-center gap-4 my-3 mx-2">
                      <div className="flex-1 h-px bg-border" />
                      <div className="w-0.5 h-0.5 rounded-full bg-border shrink-0" />
                      <div className="flex-1 h-px bg-border" />
                    </div>
                  )}
                  <ArxivDateSection section={section} />
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

const ArxivDateSection = memo(function ArxivDateSection({ section }: { section: DateSection }) {
  return (
    <div style={{ padding: "16px 8px" }}>
      <div className="grid gap-3 items-start x-grid">
        <div className="flex items-center gap-3" style={{ gridColumn: "1 / -1" }}>
          <h2 className="font-semibold" style={{ fontSize: 15, color: "var(--ring)" }}>
            {section.date}
          </h2>
          <span className="text-xs text-muted-foreground">
            {section.total} papers
          </span>
        </div>
        {section.groups.map((group) => (
          <ArxivGroupColumn key={group.name} name={group.name} items={group.items} />
        ))}
      </div>
    </div>
  )
})

const ArxivGroupColumn = memo(function ArxivGroupColumn({ name, items }: { name: string; items: ArxivItem[] }) {
  const color = getGroupColor(name)
  const columnRef = useRef<HTMLDivElement>(null)

  const columnVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => columnRef.current,
    getItemKey: (index) => items[index]?.info.id ?? index,
    estimateSize: () => 120,
    gap: 6,
    overscan: 3,
  })

  return (
    <div ref={columnRef} className="max-h-[600px] 2xl:max-h-[820px] overflow-y-scroll group-scroll" style={{ overscrollBehavior: "contain" }}>
      <div className="flex items-center gap-1.5 sticky top-0 bg-background z-[1]" style={{ padding: "4px 0" }}>
        <span className="text-xs font-semibold uppercase tracking-wide" style={{ color, letterSpacing: "0.5px" }}>
          {name}
        </span>
        <span className="text-[11px] font-normal text-muted-foreground">{items.length}</span>
      </div>
      <div style={{ height: columnVirtualizer.getTotalSize(), position: "relative" }}>
        {columnVirtualizer.getVirtualItems().map((vItem) => {
          const item = items[vItem.index]
          if (!item) return null
          return (
            <div
              key={vItem.key}
              data-index={vItem.index}
              ref={columnVirtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${vItem.start}px)`,
              }}
            >
              <PaperCard item={item} />
            </div>
          )
        })}
      </div>
    </div>
  )
})
