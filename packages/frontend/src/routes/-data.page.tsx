import { useState, useCallback, useEffect, useRef, useMemo, memo } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { XHeader } from "@/visualizers/x/header"
import { ItemCard } from "@/visualizers/x/item-card"
import { buildDateSections, getGroupColor } from "@/visualizers/x/helpers"
import type { XItem, XListResponse } from "@/visualizers/x/types"
import type { DateSection, ThreadItem } from "@/visualizers/x/helpers"
import type { FilterToken } from "@/components/filter-bar"

const PAGE_SIZE = 1000
const SSE_DEBOUNCE_MS = 500

import type { DataSource } from "@/components/source-selector"

export function XPage({ dataSource, onDataSourceChange }: { dataSource: DataSource; onDataSourceChange: (v: DataSource) => void }) {
  const [items, setItems] = useState<XItem[]>([])
  const [total, setTotal] = useState(0)
  const [totalUnfiltered, setTotalUnfiltered] = useState(0)
  const [tokens, setTokens] = useState<FilterToken[]>(() => {
    // Initialize from URL search params (e.g. /data?q=12345 from job run links)
    const params = new URLSearchParams(window.location.search)
    const q = params.get("q")
    if (q) {
      return [{ id: "tok-url-q", type: "text", label: `"${q}"`, value: q }]
    }
    return []
  })
  const tokensRef = useRef(tokens)
  tokensRef.current = tokens
  const [liveText, setLiveText] = useState("")
  const liveTextRef = useRef(liveText)
  liveTextRef.current = liveText
  const [dateMode, setDateMode] = useState(
    () =>
      (typeof localStorage !== "undefined" &&
        localStorage.getItem("xviz_dateMode")) ||
      "scrape_date",
  )
  const [sort, setSort] = useState(
    () =>
      (typeof localStorage !== "undefined" &&
        localStorage.getItem("xviz_sort")) ||
      "desc",
  )
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [backlogTags, setBacklogTags] = useState<Set<string>>(new Set())
  const [confirmedTags, setConfirmedTags] = useState<Set<string> | undefined>(undefined)
  const fetchGenRef = useRef(0)
  const dataFingerprintRef = useRef("")

  // Build query params from tokens + live text
  function buildFilterParams(toks: FilterToken[], live: string): { q: string; user?: string; tag?: string; dateField?: string; dateFrom?: string; dateTo?: string } {
    const textParts: string[] = []
    let user: string | undefined
    let tag: string | undefined
    let dateField: string | undefined
    let dateFrom: string | undefined
    let dateTo: string | undefined
    for (const t of toks) {
      if (t.type === "text") {
        textParts.push(t.value)
      } else if (t.type === "user") {
        user = t.value
      } else if (t.type === "tag") {
        tag = t.value
      } else if (t.type === "content_date" && t.dateFrom && t.dateTo) {
        dateField = "tweetAt"
        dateFrom = t.dateFrom
        dateTo = t.dateTo
      } else if (t.type === "collect_date" && t.dateFrom && t.dateTo) {
        dateField = "collectedAt"
        dateFrom = t.dateFrom
        dateTo = t.dateTo
      }
    }
    if (live.trim()) textParts.push(live.trim())
    return { q: textParts.join(" "), user, tag, dateField, dateFrom, dateTo }
  }

  // Fetch all pages of data
  const fetchAllPages = useCallback(
    async (dm: string, s: string, filterTokens: FilterToken[], live: string, isPoll = false) => {
      const gen = ++fetchGenRef.current
      if (!isPoll) setLoading(true)
      setError(null)

      const { q, user, tag, dateField, dateFrom, dateTo } = buildFilterParams(filterTokens, live)
      let allItems: XItem[] = []
      let totalCount = 0

      try {
        let pageCount = 0
        while (true) {
          const params = new URLSearchParams({
            offset: String(allItems.length),
            limit: String(PAGE_SIZE),
            dateMode: dm,
            sort: s,
            q,
            slim: "true",
          })
          if (user) params.set("user", user)
          if (tag) params.set("tag", tag)
          if (dateField && dateFrom && dateTo) {
            params.set("dateField", dateField)
            params.set("dateFrom", dateFrom)
            params.set("dateTo", dateTo)
          }
          const resp = await fetch(`/api/v1/x?${params}`)
          if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}`)
          }
          const data: XListResponse = await resp.json()
          if (gen !== fetchGenRef.current) return

          totalCount = data.total
          if (data.items.length === 0) break
          allItems = [...allItems, ...data.items]
          pageCount++

          // Progressive render on first page (initial load only, not polls)
          if (pageCount === 1 && !isPoll) {
            setItems([...allItems])
            setTotal(totalCount)
            if (!q && !user && !tag && !dateField) setTotalUnfiltered(totalCount)
          }

          if (allItems.length >= totalCount) break
        }

        if (gen !== fetchGenRef.current) return

        // On poll: skip state update if data hasn't changed (prevents repaint flash)
        const fp = `${totalCount}:${allItems[0]?.info?.id ?? ""}:${allItems[allItems.length - 1]?.info?.id ?? ""}`
        if (isPoll && fp === dataFingerprintRef.current) return
        // On poll: never replace existing items with empty result (transient backend issue)
        if (isPoll && allItems.length === 0 && totalCount === 0) return
        dataFingerprintRef.current = fp

        setItems(allItems)
        setTotal(totalCount)
        if (!q && !user && !tag && !dateField) setTotalUnfiltered(totalCount)
      } catch (err: any) {
        if (gen !== fetchGenRef.current) return
        setError(err?.message || "Failed to load posts")
      } finally {
        if (gen === fetchGenRef.current) setLoading(false)
      }
    },
    [],
  )

  // Fetch tag registry (confirmed vs backlog classification)
  const fetchTagRegistry = useCallback(async () => {
    try {
      const resp = await fetch("/api/v1/x/tags")
      if (!resp.ok) return
      const data = await resp.json() as { tags: string[]; backlogTags: string[] }
      setBacklogTags(new Set(data.backlogTags))
      setConfirmedTags(new Set(data.tags))
    } catch {
      // Graceful degradation: treat all tags as confirmed
    }
  }, [])

  // Pick up ?q= param when navigating to /data?q=... (Activity keep-alive means no remount)
  const hasFetchedRef = useRef(false)
  useEffect(() => {
    // StrictMode guard: prevent double-fetch in dev
    if (hasFetchedRef.current) return
    hasFetchedRef.current = true

    const params = new URLSearchParams(window.location.search)
    const q = params.get("q")
    if (q) {
      const newTokens = [{ id: `tok-url-${Date.now()}`, type: "text" as const, label: `"${q}"`, value: q }]
      setTokens(newTokens)
      tokensRef.current = newTokens
      fetchAllPages(dateMode, sort, newTokens, "")
      // Clean the URL so refreshing doesn't re-apply the filter
      window.history.replaceState({}, "", "/data")
      // Focus the search bar so user can backspace to remove the filter
      setTimeout(() => document.getElementById("searchInput-data")?.focus(), 100)
    } else {
      fetchAllPages(dateMode, sort, tokens, liveText)
    }
    fetchTagRegistry()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // SSE push — refetch when backend pushes data-changed (debounced for burst saves)
  useEffect(() => {
    let sseDebounce: ReturnType<typeof setTimeout> | null = null
    const handleSse = () => {
      if (sseDebounce) clearTimeout(sseDebounce)
      sseDebounce = setTimeout(() => {
        fetchAllPages(dateMode, sort, tokensRef.current, liveTextRef.current, true)
        fetchTagRegistry()
      }, SSE_DEBOUNCE_MS)
    }
    window.addEventListener("sse:data-changed", handleSse)
    return () => {
      window.removeEventListener("sse:data-changed", handleSse)
      if (sseDebounce) clearTimeout(sseDebounce)
    }
  }, [fetchAllPages, fetchTagRegistry, dateMode, sort])

  // Date mode change
  const handleDateModeChange = useCallback(
    (mode: string) => {
      setDateMode(mode)
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("xviz_dateMode", mode)
      }
      fetchAllPages(mode, sort, tokensRef.current, liveTextRef.current)
    },
    [fetchAllPages, sort],
  )

  // Sort change
  const handleSortChange = useCallback(
    (s: string) => {
      setSort(s)
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("xviz_sort", s)
      }
      fetchAllPages(dateMode, s, tokensRef.current, liveTextRef.current)
    },
    [fetchAllPages, dateMode],
  )

  // Token change — triggers immediate fetch
  const handleTokensChange = useCallback(
    (newTokens: FilterToken[]) => {
      setTokens(newTokens)
      tokensRef.current = newTokens
      fetchAllPages(dateMode, sort, newTokens, liveTextRef.current)
    },
    [fetchAllPages, dateMode, sort],
  )

  // Live text change — debounced immediate filtering as user types
  const liveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleLiveText = useCallback(
    (text: string) => {
      setLiveText(text)
      liveTextRef.current = text
      if (liveTimerRef.current) clearTimeout(liveTimerRef.current)
      liveTimerRef.current = setTimeout(() => {
        fetchAllPages(dateMode, sort, tokensRef.current, text)
      }, 200)
    },
    [fetchAllPages, dateMode, sort],
  )

  // Tag filter from item card badge click
  const handleTagFilter = useCallback(
    (tag: string) => {
      const newToken: FilterToken = {
        id: `tok-tag-${Date.now()}`,
        type: "tag",
        label: `Tag: ${tag}`,
        value: tag,
      }
      const newTokens = [...tokensRef.current.filter((t) => t.type !== "tag"), newToken]
      handleTokensChange(newTokens)
    },
    [handleTokensChange],
  )

  // Build sections — memoized, recomputes only when items or dateMode change
  const sections = useMemo(
    () => (items.length === 0 ? [] : buildDateSections(items, dateMode)),
    [items, dateMode],
  )

  // ── Section-level virtualizer ──
  // Virtualize at date-section granularity so hour-range groups remain
  // CSS grid siblings (columns), not separate full-width rows.
  const scrollAreaRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: sections.length,
    getScrollElement: () => scrollAreaRef.current,
    getItemKey: (index) => sections[index]?.date ?? index,
    // Each section: header (~40px) + column area (capped at max-h 600/820px) + padding + separator (~24px for index > 0)
    estimateSize: (index) => (index === 0 ? 692 : 716),
    overscan: 2,
  })

  // ── Card keyboard nav ──
  const lastMousePos = useRef({ x: 0, y: 0 })
  const lastHoveredCard = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const scrollArea = scrollAreaRef.current

    const handleMouseMove = (e: MouseEvent) => {
      lastMousePos.current = { x: e.clientX, y: e.clientY }
    }

    const handleMouseOver = (e: MouseEvent) => {
      const card = (e.target as HTMLElement).closest?.(".x-card") as HTMLElement | null
      if (card) lastHoveredCard.current = card
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
      if (!scrollArea || scrollArea.offsetParent === null) return
      const active = document.activeElement
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || (active as HTMLElement).isContentEditable)) return

      const { x, y } = lastMousePos.current
      const el = document.elementFromPoint(x, y)
      let card = el?.closest(".x-card") as HTMLElement | null
      if (!card) card = lastHoveredCard.current
      if (!card) return
      const column = card.closest(".group-scroll") as HTMLElement | null
      if (!column) return

      e.preventDefault()
      const cardRect = card.getBoundingClientRect()
      const gap = 6
      const scrollAmount = cardRect.height + gap
      column.scrollBy({ top: e.key === "ArrowDown" ? scrollAmount : -scrollAmount, behavior: "smooth" })
    }

    document.addEventListener("mousemove", handleMouseMove, { passive: true })
    scrollArea?.addEventListener("mouseover", handleMouseOver, { passive: true })
    document.addEventListener("keydown", handleKeyDown)
    return () => {
      document.removeEventListener("mousemove", handleMouseMove)
      scrollArea?.removeEventListener("mouseover", handleMouseOver)
      document.removeEventListener("keydown", handleKeyDown)
    }
  }, [])

  return (
    <div className="flex flex-col h-full x-theme">
      <XHeader
        dataSource={dataSource}
        onDataSourceChange={onDataSourceChange}
        tokens={tokens}
        onTokensChange={handleTokensChange}
        onLiveText={handleLiveText}
        dateMode={dateMode}
        onDateModeChange={handleDateModeChange}
        total={total}
        totalUnfiltered={totalUnfiltered}
        error={error}
      />

      <div ref={scrollAreaRef} className="flex-1 overflow-y-auto">
        {error && items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <h2 className="text-lg font-semibold text-foreground mb-2">
              Failed to load posts
            </h2>
            <p className="text-sm text-muted-foreground">{error}</p>
          </div>
        ) : items.length === 0 && loading ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="text-sm text-muted-foreground animate-pulse">Loading...</div>
          </div>
        ) : items.length === 0 && !loading ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <h2 className="text-lg font-semibold text-foreground mb-2">
              No posts found
            </h2>
            <p className="text-sm text-muted-foreground">
              {tokens.length > 0
                ? "Try different filters."
                : "Run the collector to populate data."}
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
                  <DateSectionView section={section} onTagFilter={handleTagFilter} backlogTags={backlogTags} confirmedTags={confirmedTags} />
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Section-level sub-components ──

const DateSectionView = memo(function DateSectionView({ section, onTagFilter, backlogTags, confirmedTags }: { section: DateSection; onTagFilter?: (tag: string) => void; backlogTags?: Set<string>; confirmedTags?: Set<string> }) {
  return (
    <div style={{ padding: "16px 8px" }}>
      <div className="grid gap-3 items-start x-grid">
        {/* mega-header: spans full grid width */}
        <div className="flex items-center gap-3" style={{ gridColumn: "1 / -1" }}>
          <h2 className="font-semibold" style={{ fontSize: 15, color: "var(--ring)" }}>
            {section.date}
          </h2>
          <span className="text-xs text-muted-foreground">
            {section.total} tweets
          </span>
        </div>
        {section.groups.map((group) => (
          <GroupColumn key={group.name} name={group.name} items={group.items} onTagFilter={onTagFilter} backlogTags={backlogTags} confirmedTags={confirmedTags} />
        ))}
      </div>
    </div>
  )
})

const GroupColumn = memo(function GroupColumn({ name, items, onTagFilter, backlogTags, confirmedTags }: { name: string; items: ThreadItem[]; onTagFilter?: (tag: string) => void; backlogTags?: Set<string>; confirmedTags?: Set<string> }) {
  const color = getGroupColor(name)
  const itemCount = items.reduce((n, item) => n + 1 + item.children.length, 0)
  const columnRef = useRef<HTMLDivElement>(null)

  const columnVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => columnRef.current,
    getItemKey: (index) => items[index]?.item.rawData.url ?? index,
    estimateSize: () => 180,
    gap: 6,
    overscan: 3,
  })

  return (
    <div ref={columnRef} className="max-h-[600px] 2xl:max-h-[820px] overflow-y-scroll group-scroll" style={{ overscrollBehavior: "contain" }}>
      <div className="flex items-center gap-1.5 sticky top-0 bg-background z-[1]" style={{ padding: "4px 0" }}>
        <span className="text-xs font-semibold uppercase tracking-wide" style={{ color, letterSpacing: "0.5px" }}>
          {name}
        </span>
        <span className="text-[11px] font-normal text-muted-foreground">{itemCount}</span>
      </div>
      <div style={{ height: columnVirtualizer.getTotalSize(), position: "relative" }}>
        {columnVirtualizer.getVirtualItems().map((vItem) => {
          const thread = items[vItem.index]
          if (!thread) return null
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
              <ThreadItemView item={thread} onTagFilter={onTagFilter} backlogTags={backlogTags} confirmedTags={confirmedTags} />
            </div>
          )
        })}
      </div>
    </div>
  )
})

function ThreadItemView({ item, onTagFilter, backlogTags, confirmedTags }: { item: ThreadItem; onTagFilter?: (tag: string) => void; backlogTags?: Set<string>; confirmedTags?: Set<string> }) {
  const [expanded, setExpanded] = useState(false)

  if (item.children.length === 0) {
    return <ItemCard item={item.item} onTagFilter={onTagFilter} backlogTags={backlogTags} confirmedTags={confirmedTags} />
  }

  return (
    <>
      <ItemCard item={item.item} onTagFilter={onTagFilter} backlogTags={backlogTags} confirmedTags={confirmedTags} />
      <div className="ml-2 pl-2 border-l-2 border-border">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-2 text-xs py-1.5 px-3 rounded-md transition-colors hover:bg-[rgba(88,166,255,0.15)]"
          style={{ color: "#58a6ff", background: expanded ? "rgba(88,166,255,0.1)" : "rgba(88,166,255,0.05)", border: "1px solid rgba(88,166,255,0.2)" }}
        >
          <span style={{ fontSize: 10 }}>{expanded ? "\u25BC" : "\u25B6"}</span>
          <span>{item.children.length} {item.children.length === 1 ? "reply" : "replies"}</span>
        </button>
        {expanded && (
          <div className="flex flex-col gap-2 mt-2 text-[0.95em] [&>div]:rounded-md">
            {item.children.map((child) => (
              <ItemCard key={child.rawData.url} item={child} onTagFilter={onTagFilter} backlogTags={backlogTags} confirmedTags={confirmedTags} />
            ))}
          </div>
        )}
      </div>
    </>
  )
}
