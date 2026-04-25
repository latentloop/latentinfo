import { useState, useCallback, useEffect, useRef, useMemo, memo } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { XHeader } from "@/visualizers/x/header"
import { ItemCard } from "@/visualizers/x/item-card"
import { buildDateSections, getDateStr, getGroupColor } from "@/visualizers/x/helpers"
import type { XItem, XListResponse, XSummaryResponse } from "@/visualizers/x/types"
import type { DateSection, ThreadItem } from "@/visualizers/x/helpers"
import type { FilterToken } from "@/components/filter-bar"

const INITIAL_FETCH_PAGE_SIZE = 120
const DAY_FETCH_PAGE_SIZE = 1000
const DAY_BATCH_COUNT = 2
const HOUR_GROUP_INITIAL_THREADS = 18
const HOUR_GROUP_LOAD_MORE_THREADS = 18
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
  const [loadingMore, setLoadingMore] = useState(false)
  const itemsRef = useRef<XItem[]>([])
  itemsRef.current = items
  const dateModeRef = useRef(dateMode)
  dateModeRef.current = dateMode
  const sortRef = useRef(sort)
  sortRef.current = sort
  const loadingRef = useRef(loading)
  loadingRef.current = loading
  const loadingMoreRef = useRef(loadingMore)
  loadingMoreRef.current = loadingMore
  const [hasMoreDays, setHasMoreDays] = useState(false)
  const [backlogTags, setBacklogTags] = useState<Set<string>>(new Set())
  const [confirmedTags, setConfirmedTags] = useState<Set<string> | undefined>(undefined)
  const fetchGenRef = useRef(0)
  const loadedDatesRef = useRef<string[]>([])
  const dataFingerprintRef = useRef("")
  const pendingSseRefreshRef = useRef(false)

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

  function dateFieldForMode(dm: string): "tweetAt" | "collectedAt" {
    return dm === "scrape_date" ? "collectedAt" : "tweetAt"
  }

  function dayBounds(date: string): { from: string; to: string } {
    const [year, month, day] = date.split("-").map((part) => parseInt(part, 10))
    const start = new Date(year, month - 1, day)
    const end = new Date(year, month - 1, day + 1)
    return {
      from: start.toISOString(),
      to: new Date(end.getTime() - 1).toISOString(),
    }
  }

  function boundaryForLoadedDates(dm: string, s: string, dates: string[], params: URLSearchParams): void {
    if (dates.length === 0) return
    const sorted = [...dates].sort()
    const field = dateFieldForMode(dm)
    params.set("dateField", field)
    if (s === "asc") {
      const latest = sorted[sorted.length - 1]!
      const nextStart = new Date(new Date(dayBounds(latest).to).getTime() + 1).toISOString()
      params.set("dateFrom", nextStart)
    } else {
      const oldest = sorted[0]!
      const beforeOldest = new Date(new Date(dayBounds(oldest).from).getTime() - 1).toISOString()
      params.set("dateTo", beforeOldest)
    }
  }

  function dedupeItems(list: XItem[]): XItem[] {
    const seen = new Set<string>()
    const deduped: XItem[] = []
    for (const item of list) {
      if (seen.has(item.info.id)) continue
      seen.add(item.info.id)
      deduped.push(item)
    }
    return deduped
  }

  function orderDates(dates: string[], s: string): string[] {
    const sorted = Array.from(new Set(dates)).sort()
    return s === "asc" ? sorted : sorted.reverse()
  }

  function addLoadedDates(dates: string[], s: string): void {
    if (dates.length === 0) return
    loadedDatesRef.current = orderDates([...loadedDatesRef.current, ...dates], s)
  }

  function commitBatch(batch: XItem[]): void {
    if (batch.length === 0) return
    const seen = new Set(itemsRef.current.map((item) => item.info.id))
    const additions = batch.filter((item) => !seen.has(item.info.id))
    if (additions.length === 0) return
    const merged = [...itemsRef.current, ...additions]
    itemsRef.current = merged
    setItems(merged)
    setTotal(merged.length)
  }

  async function fetchSummary(gen: number): Promise<void> {
    try {
      const resp = await fetch("/api/v1/x/summary")
      if (!resp.ok) return
      const data = await resp.json() as XSummaryResponse
      if (gen !== fetchGenRef.current) return
      setTotalUnfiltered(data.total)
    } catch {
      // Summary is best-effort; loaded item count remains visible.
    }
  }

  async function fetchPage(baseParams: URLSearchParams, offset: number, limit: number): Promise<XListResponse> {
    const params = new URLSearchParams(baseParams)
    params.set("offset", String(offset))
    params.set("limit", String(limit))
    params.set("slim", "true")

    const resp = await fetch(`/api/v1/x?${params}`)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    return resp.json() as Promise<XListResponse>
  }

  async function loadRangePages(
    baseParams: URLSearchParams,
    gen: number,
    onBatch: (batch: XItem[]) => void,
  ): Promise<XItem[] | null> {
    let offset = 0
    let limit = INITIAL_FETCH_PAGE_SIZE
    const loaded: XItem[] = []

    while (true) {
      const data = await fetchPage(baseParams, offset, limit)
      if (gen !== fetchGenRef.current) return null
      if (data.items.length > 0) {
        loaded.push(...data.items)
        onBatch(data.items)
      }
      if (!data.hasMore || data.items.length === 0) break
      offset += data.items.length
      limit = DAY_FETCH_PAGE_SIZE
    }

    return loaded
  }

  async function probeNextDate(
    dm: string,
    s: string,
    baseParams: URLSearchParams,
    loadedDates: string[],
  ): Promise<{ date: string } | null> {
    const probeParams = new URLSearchParams(baseParams)
    probeParams.set("offset", "0")
    probeParams.set("limit", "1")
    probeParams.set("slim", "true")
    boundaryForLoadedDates(dm, s, loadedDates, probeParams)

    const probeResp = await fetch(`/api/v1/x?${probeParams}`)
    if (!probeResp.ok) throw new Error(`HTTP ${probeResp.status}`)
    const probeData: XListResponse = await probeResp.json()
    const date = probeData.items[0] ? getDateStr(probeData.items[0], dm) : null
    return date ? { date } : null
  }

  // Load local-day batches incrementally. The first page commits immediately;
  // remaining pages continue in the background so first paint is not blocked by
  // complete-day hydration.
  const fetchDay = useCallback(
    async (
      dm: string,
      s: string,
      filterTokens: FilterToken[],
      live: string,
      options: { append?: boolean; isPoll?: boolean; refreshDates?: string[] } = {},
    ) => {
      const { append = false, isPoll = false, refreshDates } = options
      const gen = append ? fetchGenRef.current : ++fetchGenRef.current
      if (!append && !isPoll) {
        itemsRef.current = []
        loadedDatesRef.current = []
        setItems([])
        setTotal(0)
        setLoading(true)
      }
      if (append) setLoadingMore(true)
      setError(null)

      const { q, user, tag, dateField, dateFrom, dateTo } = buildFilterParams(filterTokens, live)
      const hasFilters = Boolean(q || user || tag || dateField)
      if (!append && !isPoll && !hasFilters) void fetchSummary(gen)

      try {
        const baseParams = new URLSearchParams({
          dateMode: dm,
          sort: s,
          q,
        })
        if (user) baseParams.set("user", user)
        if (tag) baseParams.set("tag", tag)

        let pollItems: XItem[] = []
        const receiveBatch = (batch: XItem[]) => {
          if (isPoll) {
            pollItems.push(...batch)
          } else {
            commitBatch(batch)
          }
        }

        if (dateField && dateFrom && dateTo) {
          baseParams.set("dateField", dateField)
          baseParams.set("dateFrom", dateFrom)
          baseParams.set("dateTo", dateTo)
          const rangeItems = await loadRangePages(baseParams, gen, receiveBatch)
          if (rangeItems === null) return
          const datesToLoad = Array.from(new Set(rangeItems.map((item) => getDateStr(item, dm)).filter(Boolean) as string[]))
          loadedDatesRef.current = orderDates(datesToLoad, s)
          setHasMoreDays(false)
        } else {
          let targetDates = refreshDates ? orderDates(refreshDates, s) : []

          if (isPoll && targetDates.length > 0) {
            const headProbe = await probeNextDate(dm, s, baseParams, [])
            if (gen !== fetchGenRef.current) return
            if (headProbe && !targetDates.includes(headProbe.date)) {
              targetDates = orderDates([...targetDates, headProbe.date], s)
            }
          } else if (targetDates.length === 0) {
            const probeLoadedDates = append ? [...loadedDatesRef.current] : []
            for (let i = 0; i < DAY_BATCH_COUNT; i++) {
              const probe = await probeNextDate(dm, s, baseParams, probeLoadedDates)
              if (gen !== fetchGenRef.current) return
              if (!probe) break
              targetDates.push(probe.date)
              probeLoadedDates.push(probe.date)
            }

            if (targetDates.length === 0) {
              if (!append) {
                itemsRef.current = []
                setItems([])
                setTotal(0)
                setHasMoreDays(false)
                loadedDatesRef.current = []
              } else {
                setHasMoreDays(false)
              }
              return
            }
          }

          const completedDates: string[] = []
          for (const date of targetDates) {
            const bounds = dayBounds(date)
            const rangeParams = new URLSearchParams(baseParams)
            rangeParams.set("dateField", dateFieldForMode(dm))
            rangeParams.set("dateFrom", bounds.from)
            rangeParams.set("dateTo", bounds.to)
            const dayItems = await loadRangePages(rangeParams, gen, receiveBatch)
            if (gen !== fetchGenRef.current) return
            if (dayItems === null) return
            if (dayItems.length > 0) {
              completedDates.push(date)
              if (!isPoll) addLoadedDates([date], s)
            }
          }

          if (isPoll) {
            loadedDatesRef.current = orderDates(completedDates, s)
          }
          const moreProbe = await probeNextDate(dm, s, baseParams, loadedDatesRef.current)
          if (gen !== fetchGenRef.current) return
          setHasMoreDays(Boolean(moreProbe))
        }

        if (isPoll) {
          const nextItems = dedupeItems(pollItems)
          const fp = `${nextItems.length}:${nextItems[0]?.info?.id ?? ""}:${nextItems[nextItems.length - 1]?.info?.id ?? ""}:${loadedDatesRef.current.join(",")}`
          if (fp === dataFingerprintRef.current) return
          // Never replace visible items with an empty poll result.
          if (nextItems.length === 0 && itemsRef.current.length > 0) return
          dataFingerprintRef.current = fp
          itemsRef.current = nextItems
          setItems(nextItems)
          setTotal(nextItems.length)
        } else {
          const currentItems = itemsRef.current
          dataFingerprintRef.current = `${currentItems.length}:${currentItems[0]?.info?.id ?? ""}:${currentItems[currentItems.length - 1]?.info?.id ?? ""}:${loadedDatesRef.current.join(",")}`
        }
      } catch (err: any) {
        if (gen !== fetchGenRef.current) return
        setError(err?.message || "Failed to load posts")
      } finally {
        if (gen === fetchGenRef.current) {
          loadingRef.current = false
          loadingMoreRef.current = false
          setLoading(false)
          setLoadingMore(false)
          if (!isPoll && pendingSseRefreshRef.current) {
            pendingSseRefreshRef.current = false
            window.setTimeout(() => {
              window.dispatchEvent(new CustomEvent("sse:data-changed"))
            }, 0)
          }
        }
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

  // Pick up ?q= param when navigating to /data?q=...
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
      fetchDay(dateMode, sort, newTokens, "")
      // Clean the URL so refreshing doesn't re-apply the filter
      window.history.replaceState({}, "", "/data")
      // Focus the search bar so user can backspace to remove the filter
      setTimeout(() => document.getElementById("searchInput-data")?.focus(), 100)
    } else {
      fetchDay(dateMode, sort, tokens, liveText)
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
        if (loadingRef.current || loadingMoreRef.current) {
          pendingSseRefreshRef.current = true
          fetchTagRegistry()
          return
        }
        fetchDay(dateModeRef.current, sortRef.current, tokensRef.current, liveTextRef.current, {
          isPoll: true,
          refreshDates: loadedDatesRef.current,
        })
        fetchTagRegistry()
      }, SSE_DEBOUNCE_MS)
    }
    window.addEventListener("sse:data-changed", handleSse)
    return () => {
      window.removeEventListener("sse:data-changed", handleSse)
      if (sseDebounce) clearTimeout(sseDebounce)
    }
  }, [fetchDay, fetchTagRegistry, dateMode, sort])

  // Date mode change
  const handleDateModeChange = useCallback(
    (mode: string) => {
      setDateMode(mode)
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("xviz_dateMode", mode)
      }
      fetchDay(mode, sort, tokensRef.current, liveTextRef.current)
    },
    [fetchDay, sort],
  )

  // Sort change
  const handleSortChange = useCallback(
    (s: string) => {
      setSort(s)
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("xviz_sort", s)
      }
      fetchDay(dateMode, s, tokensRef.current, liveTextRef.current)
    },
    [fetchDay, dateMode],
  )

  // Token change — triggers immediate fetch
  const handleTokensChange = useCallback(
    (newTokens: FilterToken[]) => {
      setTokens(newTokens)
      tokensRef.current = newTokens
      fetchDay(dateMode, sort, newTokens, liveTextRef.current)
    },
    [fetchDay, dateMode, sort],
  )

  // Live text change — debounced immediate filtering as user types
  const liveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleLiveText = useCallback(
    (text: string) => {
      setLiveText(text)
      liveTextRef.current = text
      if (liveTimerRef.current) clearTimeout(liveTimerRef.current)
      liveTimerRef.current = setTimeout(() => {
        fetchDay(dateMode, sort, tokensRef.current, text)
      }, 200)
    },
    [fetchDay, dateMode, sort],
  )

  const handleLoadMore = useCallback(() => {
    if (loading || loadingMore || !hasMoreDays) return
    fetchDay(dateMode, sort, tokensRef.current, liveTextRef.current, {
      append: true,
    })
  }, [dateMode, fetchDay, hasMoreDays, loading, loadingMore, sort])

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
  const hasActiveFilters = tokens.length > 0 || liveText.trim().length > 0

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
        hasActiveFilters={hasActiveFilters}
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
          <>
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
            {hasMoreDays ? (
              <div className="flex justify-center py-4">
                <button
                  type="button"
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                  className="rounded-md border border-border bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/80 disabled:opacity-60"
                >
                  {loadingMore ? "Loading..." : sort === "asc" ? "Load next 2 days" : "Load previous 2 days"}
                </button>
              </div>
            ) : null}
          </>
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
  const [visibleThreadCount, setVisibleThreadCount] = useState(HOUR_GROUP_INITIAL_THREADS)
  const visibleItems = items.slice(0, visibleThreadCount)

  useEffect(() => {
    setVisibleThreadCount(HOUR_GROUP_INITIAL_THREADS)
  }, [name, items[0]?.item.info.id])

  const columnVirtualizer = useVirtualizer({
    count: visibleItems.length,
    getScrollElement: () => columnRef.current,
    getItemKey: (index) => visibleItems[index]?.item.rawData.url ?? index,
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
          const thread = visibleItems[vItem.index]
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
      {visibleItems.length < items.length ? (
        <button
          type="button"
          onClick={() => setVisibleThreadCount((count) => Math.min(items.length, count + HOUR_GROUP_LOAD_MORE_THREADS))}
          className="mt-2 w-full rounded-md border border-border bg-muted/60 px-2 py-1.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          Show more in {name} ({visibleItems.length}/{items.length})
        </button>
      ) : null}
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
