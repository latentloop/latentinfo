import React, { useState, useEffect, useCallback, useRef, useMemo, Suspense } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Badge } from "@/components/ui/badge"
import { FilterBar, type FilterToken, type FilterCategory } from "@/components/filter-bar"
import { Icon } from "@iconify/react"
import { darkTheme } from "@uiw/react-json-view/dark"

const LazyRunResultJsonView = React.lazy(() =>
  import("@uiw/react-json-view").then((mod) => ({
    default: function RunResultJsonView(props: {
      result: Record<string, unknown>
      renderTweetLink: (value: string) => React.ReactNode
    }) {
      const JV = mod.default
      return (
        <JV
          value={props.result}
          style={{ ...darkTheme, backgroundColor: "transparent", fontSize: 11 }}
          collapsed={false}
          displayDataTypes={false}
          displayObjectSize={false}
        >
          <JV.String
            render={({ children, ...rest }: any, { value }: any) => {
              if (typeof value === "string" && /^x:\d+$/.test(value)) {
                return <>{props.renderTweetLink(value)}</>
              }
              return <span {...rest}>{children}</span>
            }}
          />
        </JV>
      )
    },
  }))
)
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

const PAGE_SIZE = 50

interface JobRunInfo {
  id: string
  jobId: string
  trigger: string
  status: string
  startedAt: string
  finishedAt: string | null
  error: string | null
  result: Record<string, unknown> | null
}

interface JobListItem {
  id: string
  description: string
}

// ---------------------------------------------------------------------------
// Filter categories
// ---------------------------------------------------------------------------

const FILTER_CATEGORIES: readonly FilterCategory<"text" | "job" | "status" | "run_date">[] = [
  { type: "text", label: "Text", hint: "search in errors, results" },
  { type: "job", label: "Job", hint: "x_tag, arxiv_collect" },
  { type: "status", label: "Status", hint: "success, error, running" },
  { type: "run_date", label: "Run Date", hint: "yesterday, march 15, 2026-03" },
] as const
const DATE_TYPES = new Set(["run_date"] as const)

let nextTokenId = 0

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function JobRunsPage() {
  const [allRuns, setAllRuns] = useState<JobRunInfo[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [expandedError, setExpandedError] = useState<string | null>(null)
  const [dateWindowDays, setDateWindowDays] = useState(3)
  const [hasMore, setHasMore] = useState(true)

  // Filter state — initialize from URL params if present
  const [tokens, setTokens] = useState<FilterToken[]>(() => {
    const params = new URLSearchParams(window.location.search)
    const runIdParam = params.get("runId")
    if (runIdParam) {
      return [{ id: `tok-${++nextTokenId}`, type: "text", label: `"${runIdParam}"`, value: runIdParam }]
    }
    const jobParam = params.get("job")
    if (jobParam) {
      return [{ id: `tok-${++nextTokenId}`, type: "job", label: `Job: ${jobParam}`, value: jobParam }]
    }
    return []
  })
  const tokensRef = useRef(tokens)
  tokensRef.current = tokens
  const [liveText, setLiveText] = useState("")

  // Check if tokens contain a run_date filter (user set explicit date range)
  const hasDateFilter = tokens.some((t) => t.type === "run_date" && t.dateFrom && t.dateTo)

  // Fetch runs with date window
  const fetchRuns = useCallback(() => {
    setLoading(true)
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) })
    // If linked from dashboard with a specific runId, ensure it's included in results
    const urlRunId = new URLSearchParams(window.location.search).get("runId")
    if (urlRunId) params.set("runId", urlRunId)
    // Apply date window when no explicit date filter is set
    if (!hasDateFilter) {
      const dateFrom = new Date(Date.now() - dateWindowDays * 86400_000).toISOString()
      params.set("dateFrom", dateFrom)
    }
    fetch(`/api/v1/jobs/runs?${params}`)
      .then((r) => r.json())
      .then((data: { runs: JobRunInfo[]; total: number }) => {
        setAllRuns(data.runs)
        setTotal(data.total)
        // If we loaded nothing, there's nothing more to fetch
        if (data.runs.length === 0) {
          setHasMore(false)
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [dateWindowDays, hasDateFilter])

  useEffect(() => {
    fetchRuns()
    const handleBackendEvent = () => fetchRuns()
    window.addEventListener("backend:jobs-updated", handleBackendEvent)
    return () => { window.removeEventListener("backend:jobs-updated", handleBackendEvent) }
  }, [fetchRuns])

  // Watch for URL ?job= param changes (e.g., navigation from dashboard link)
  useEffect(() => {
    const handler = () => {
      const params = new URLSearchParams(window.location.search)
      const jobParam = params.get("job")
      const runIdParam = params.get("runId")
      if (runIdParam) {
        setTokens([{ id: `tok-${++nextTokenId}`, type: "text", label: `"${runIdParam}"`, value: runIdParam }])
      } else if (jobParam) {
        setTokens((prev) => {
          const hasJobToken = prev.some((t) => t.type === "job")
          if (hasJobToken) {
            return prev.map((t) => t.type === "job" ? { ...t, value: jobParam, label: `Job: ${jobParam}` } : t)
          }
          return [{ id: `tok-${++nextTokenId}`, type: "job", label: `Job: ${jobParam}`, value: jobParam }, ...prev]
        })
      }
    }
    window.addEventListener("popstate", handler)
    // Also run on mount so direct /jobs?job=... links apply immediately.
    handler()
    return () => window.removeEventListener("popstate", handler)
  }, [])

  // Load more runs (expand date window by 3 days)
  const handleLoadMore = useCallback(() => {
    setDateWindowDays((prev) => prev + 3)
    setHasMore(true)
  }, [])

  // Apply filters
  const hasFilters = tokens.length > 0 || liveText.trim().length > 0
  const filteredRuns = allRuns.filter((r) => {
    // Live text filter (before committing to a category)
    if (liveText.trim()) {
      const q = liveText.trim().toLowerCase()
      const matches =
        r.id.toLowerCase().includes(q) ||
        r.jobId.toLowerCase().includes(q) ||
        r.status.toLowerCase().includes(q) ||
        (r.error?.toLowerCase().includes(q) ?? false) ||
        (r.result ? JSON.stringify(r.result).toLowerCase().includes(q) : false)
      if (!matches) return false
    }

    // Token filters (AND logic)
    for (const tok of tokens) {
      if (tok.type === "job") {
        if (!r.jobId.toLowerCase().includes(tok.value.toLowerCase())) return false
      } else if (tok.type === "status") {
        if (!r.status.toLowerCase().includes(tok.value.toLowerCase())) return false
      } else if (tok.type === "run_date") {
        if (tok.dateFrom && tok.dateTo) {
          const runTime = r.startedAt
          if (runTime < tok.dateFrom || runTime > tok.dateTo) return false
        }
      } else if (tok.type === "text") {
        const q = tok.value.toLowerCase()
        const matches =
          r.id.toLowerCase().includes(q) ||
          r.jobId.toLowerCase().includes(q) ||
          r.status.toLowerCase().includes(q) ||
          (r.error?.toLowerCase().includes(q) ?? false) ||
          (r.result ? JSON.stringify(r.result).toLowerCase().includes(q) : false)
        if (!matches) return false
      }
    }
    return true
  })

  // Group filtered runs by date
  const dateSections = useMemo(() => {
    if (filteredRuns.length === 0) return []
    const byDate: Record<string, JobRunInfo[]> = {}
    for (const run of filteredRuns) {
      const d = new Date(run.startedAt)
      const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      if (!byDate[dateKey]) byDate[dateKey] = []
      byDate[dateKey].push(run)
    }
    return Object.keys(byDate)
      .sort()
      .reverse()
      .map((date) => ({ date, runs: byDate[date]! }))
  }, [filteredRuns])

  // ── Section-level virtualizer ──
  const scrollAreaRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: dateSections.length,
    getScrollElement: () => scrollAreaRef.current,
    estimateSize: () => 300,
    overscan: 2,
  })

  // ── Scroll sentinel: auto-load more when near bottom ──
  const virtualItems = virtualizer.getVirtualItems()
  const lastItem = virtualItems[virtualItems.length - 1]
  useEffect(() => {
    if (!lastItem) return
    if (lastItem.index >= dateSections.length - 2 && hasMore && !loading && !hasDateFilter) {
      handleLoadMore()
    }
  }, [lastItem?.index, dateSections.length, hasMore, loading, hasDateFilter, handleLoadMore])

  return (
    <div className="flex flex-col h-full max-w-7xl mx-auto w-full">
      <header className="sticky top-0 z-10 border-b border-border bg-muted px-6 py-1.5">
        <div className="flex items-center gap-1.5 justify-end">
          {total > 0 ? (
            <Badge variant="secondary" className="whitespace-nowrap text-[11px] px-1.5 py-0">
              {hasFilters
                ? `${filteredRuns.length} / ${total}`
                : String(total)}{" "}
              runs
            </Badge>
          ) : null}

          <FilterBar
            categories={FILTER_CATEGORIES}
            tokens={tokens}
            onTokensChange={setTokens}
            onLiveText={setLiveText}
            dateTypes={DATE_TYPES}
            inputId="searchInput-jobs"
            placeholder="Filter runs..."
            className="min-w-[200px]"
            style={{ width: 280 }}
          />
        </div>
      </header>

      <div ref={scrollAreaRef} className="flex-1 overflow-y-auto px-6 py-4">
        {filteredRuns.length === 0 && !loading ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <h2 className="text-lg font-semibold text-foreground mb-2">
              {hasFilters ? "No matching runs" : "No runs yet"}
            </h2>
            <p className="text-sm text-muted-foreground">
              {hasFilters
                ? "Try a different filter."
                : "Run a job from the dashboard to see history here."}
            </p>
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const section = dateSections[virtualRow.index]
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
                  <div className="mb-1 px-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm text-ring">{section.date}</span>
                      <span className="text-[11px] text-muted-foreground">{section.runs.length} runs</span>
                    </div>
                  </div>
                  <div className="border border-border rounded-lg overflow-hidden">
                    <Table style={{ tableLayout: "fixed" }}>
                      <colgroup>
                        <col style={{ width: "120px" }} />
                        <col style={{ width: "360px" }} />
                        <col style={{ width: "auto" }} />
                      </colgroup>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Job</TableHead>
                          <TableHead>Run ID</TableHead>
                          <TableHead>Result</TableHead>
                          <TableHead>Status</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {section.runs.map((run) => (
                          <RunRow key={run.id} run={run} expandedError={expandedError} onToggleError={setExpandedError} />
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function formatDuration(start: string, end: string | null): string {
  if (!end) return "\u2014"
  const ms = new Date(end).getTime() - new Date(start).getTime()
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 60000)}m`
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

function statusText(status: string) {
  const color = status === "success" ? "text-green-500" : status === "error" ? "text-red-400" : status === "running" ? "text-yellow-500" : "text-muted-foreground"
  return <span className={`font-medium ${color}`}>{status}</span>
}

function RunRow({ run, expandedError, onToggleError }: { run: JobRunInfo; expandedError: string | null; onToggleError: (id: string | null) => void }) {
  return (
    <TableRow>
      <TableCell className="text-sm font-medium whitespace-nowrap">{run.jobId}</TableCell>
      <TableCell>
        <div className="inline-flex items-center gap-1.5">
          <code className="text-[11px] text-muted-foreground font-mono whitespace-nowrap">{run.id}</code>
          <button
            type="button"
            onClick={() => navigator.clipboard.writeText(run.id)}
            className="text-muted-foreground hover:text-foreground hover:bg-muted shrink-0 p-1 rounded border border-border"
            title="Copy run ID"
          >
            <Icon icon="solar:copy-bold" width={12} />
          </button>
        </div>
      </TableCell>
      <TableCell className="overflow-hidden">
        {run.result ? <RunResultSummary result={run.result} /> : <span className="text-xs text-muted-foreground">&mdash;</span>}
      </TableCell>
      <TableCell>
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <span className="text-muted-foreground">Status</span>
          <span>{statusText(run.status)}</span>
          <span className="text-muted-foreground">Started</span>
          <span className="text-foreground whitespace-nowrap">{formatTime(run.startedAt)}</span>
          <span className="text-muted-foreground">Duration</span>
          <span className="text-foreground">{formatDuration(run.startedAt, run.finishedAt)}</span>
          {run.error && (
            <>
              <span className="text-muted-foreground">Error</span>
              <button
                type="button"
                onClick={() => onToggleError(expandedError === run.id ? null : run.id)}
                className="text-left text-red-400 hover:text-red-300 max-w-[500px]"
              >
                {expandedError === run.id ? run.error : run.error.slice(0, 80) + (run.error.length > 80 ? "..." : "")}
              </button>
            </>
          )}
        </div>
      </TableCell>
    </TableRow>
  )
}

function TweetIdLink({ value }: { value: string }) {
  if (/^x:\d+$/.test(value)) {
    const tweetId = value.slice(2)
    return (
      <a
        href={`/data?q=${encodeURIComponent(tweetId)}`}
        className="text-primary hover:underline cursor-pointer"
        onClick={(e) => { e.preventDefault(); window.location.href = `/data?q=${encodeURIComponent(tweetId)}` }}
      >
        "{value}"
      </a>
    )
  }
  return <span>"{value}"</span>
}

function RunResultSummary({ result }: { result: Record<string, unknown> }) {
  return (
    <div className="text-[11px] max-w-[400px]">
      <Suspense fallback={<div className="text-xs text-muted-foreground p-2">Loading...</div>}>
        <LazyRunResultJsonView
          result={result}
          renderTweetLink={(value) => <TweetIdLink value={value} />}
        />
      </Suspense>
    </div>
  )
}
