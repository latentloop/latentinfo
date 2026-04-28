import { useState, useEffect, useCallback, useRef, Component, type ReactNode, type ImgHTMLAttributes } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Icon } from "@iconify/react"
import { FilterBar, type FilterToken, type FilterCategory } from "@/components/filter-bar"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import "temml/dist/Temml-Local.css"
import temmlScriptUrl from "temml/dist/temml.min.js?url"

// Load temml via dynamic script tag — Vite's dependency optimizer corrupts the ESM build,
// causing \text to render as individual characters. The UMD build works correctly.
let _temml: any = null
function getTemml(): any {
  if (_temml) return _temml
  // In browser: load synchronously if already available on window (from script tag)
  if (typeof window !== "undefined" && (window as any).temml) {
    _temml = (window as any).temml
    return _temml
  }
  return null
}

// Eagerly inject the script tag on module load
if (typeof document !== "undefined" && !document.getElementById("temml-script")) {
  const s = document.createElement("script")
  s.id = "temml-script"
  s.src = temmlScriptUrl
  document.head.appendChild(s)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Unescape HTML entities in a LaTeX string extracted from an HTML attribute. */
function unescapeLatex(latex: string): string {
  return latex.replace(/\\\\/g, "\\").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
}

/** Render a LaTeX string to a MathML string via temml.renderToString().
 *  Returns the original match unchanged if temml is not loaded or rendering fails. */
function renderLatexToString(latex: string, display: boolean, fallback: string): string {
  const t = getTemml()
  if (!t) return fallback
  try {
    return t.renderToString(latex, { displayMode: display, throwOnError: false })
  } catch {
    return fallback
  }
}

/** Replace math elements in raw HTML with rendered MathML strings.
 *  Uses temml.renderToString() so the output is a plain HTML string that
 *  survives React re-renders (no post-mount DOM patching needed). */
function renderMathInline(html: string): string {
  // Strategy A: <math data-latex="..."> — Defuddle output
  let result = html.replace(
    /<math\s[^>]*data-latex="([^"]*)"[^>]*>[\s\S]*?<\/math>/gi,
    (match, latex: string) => renderLatexToString(unescapeLatex(latex), true, match),
  )
  // Strategy B: <annotation encoding="application/x-tex"> inside .katex
  result = result.replace(
    /<span[^>]*class="katex[^"]*"[^>]*>[\s\S]*?<annotation\s+encoding="application\/x-tex">([^<]*)<\/annotation>[\s\S]*?<\/span>/gi,
    (match, latex: string) => renderLatexToString(unescapeLatex(latex), match.includes("katex-display"), match),
  )
  return result
}

/** Sanitize article HTML: remove script tags, event handlers, and javascript: URLs.
 *  Replaces <video> elements with a placeholder linking to the original post.
 *  Math equations are rendered inline via temml.renderToString(). */
function sanitizeArticleHtml(html: string, postUrl?: string): string {
  // Render math to MathML strings before innerHTML parsing (which corrupts raw MathML attributes)
  const mathRendered = renderMathInline(html);
  const div = document.createElement("div");
  div.innerHTML = mathRendered;
  // Remove dangerous elements
  for (const el of div.querySelectorAll("script, iframe, object, embed, form")) {
    el.remove();
  }
  // Remove event handler attributes, javascript: URLs, and blob: URLs from all elements
  for (const el of div.querySelectorAll("*")) {
    for (const attr of Array.from(el.attributes)) {
      const val = attr.value.trim().toLowerCase();
      if (attr.name.startsWith("on") ||
          ((attr.name === "href" || attr.name === "src") && (val.startsWith("javascript:") || val.startsWith("blob:")))) {
        el.removeAttribute(attr.name);
      }
    }
  }
  // Force all links to open in the external browser (not inside the Electron app)
  for (const a of Array.from(div.querySelectorAll("a[href]"))) {
    a.setAttribute("target", "_blank")
    a.setAttribute("rel", "noopener noreferrer")
  }
  // Replace video embeds (not image embeds) with a clickable placeholder.
  // X articles use .twitter-article-media-caption-id for ALL media captions.
  // Video containers have no <img> tags (just an empty 16:9 div with a spinner SVG).
  // Image containers have actual <img> elements — leave those alone.
  if (postUrl) {
    for (const cap of Array.from(div.querySelectorAll(".twitter-article-media-caption-id"))) {
      const captionText = cap.textContent?.trim() || "";
      const container = cap.parentElement?.parentElement;
      if (!container) continue;
      // Only replace video embeds — they have an SVG loading spinner with <circle> elements.
      // Image embeds don't have this. Skip anything that isn't a video.
      if (!container.querySelector("svg circle")) continue;
      const link = document.createElement("a");
      link.href = postUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.className = "video-placeholder";
      link.innerHTML = `<div class="video-placeholder-inner"><svg width="36" height="36" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="12" fill="rgba(255,255,255,0.15)"/><polygon points="10,7 10,17 18,12" fill="rgba(255,255,255,0.8)"/></svg><span>Visit original URL to watch video</span></div>${captionText ? `<div class="video-placeholder-caption">${captionText}</div>` : ""}`;
      container.replaceWith(link);
    }
  }
  // Replace bare <video> elements without playable sources with a placeholder
  for (const vid of Array.from(div.querySelectorAll("video"))) {
    const hasSrc = vid.getAttribute("src") || vid.querySelector("source[src]")
    if (hasSrc) continue
    const placeholder = document.createElement("div")
    placeholder.className = "video-placeholder"
    if (postUrl) {
      const link = document.createElement("a")
      link.href = postUrl
      link.target = "_blank"
      link.rel = "noopener noreferrer"
      link.innerHTML = `<div class="video-placeholder-inner"><svg width="36" height="36" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="12" fill="rgba(255,255,255,0.15)"/><polygon points="10,7 10,17 18,12" fill="rgba(255,255,255,0.8)"/></svg><span>Visit original post for video</span></div>`
      placeholder.appendChild(link)
    } else {
      placeholder.innerHTML = `<div class="video-placeholder-inner" style="opacity:0.4"><svg width="36" height="36" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="12" fill="rgba(255,255,255,0.15)"/><polygon points="10,7 10,17 18,12" fill="rgba(255,255,255,0.8)"/></svg><span>Video unavailable</span></div>`
    }
    vid.replaceWith(placeholder)
  }
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ArticleListItem {
  id: string
  source_key?: string
  collect_data: string
  content: string
  markdown: string
  media_data: string[]
  markdown_full_path?: string
  created_at: string
  version_count?: number
}

interface ParsedCollectData {
  author?: string
  handle?: string
  title?: string
  url?: string
  avatarUrl?: string
  displayName?: string
  tweetDate?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseCollectData(raw: string): ParsedCollectData {
  try {
    const data = JSON.parse(raw)
    return {
      author: data.author || data.displayName || data.handle || undefined,
      handle: data.handle || data.user || undefined,
      title: data.title || data.text || undefined,
      url: data.url || data.sourceUrl || undefined,
      avatarUrl: data.avatarUrl || undefined,
      displayName: data.displayName || undefined,
      tweetDate: data.tweetDate || undefined,
    }
  } catch {
    return {}
  }
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
  } catch {
    return iso
  }
}

// ---------------------------------------------------------------------------
// backend event debounce constant
// ---------------------------------------------------------------------------

const BACKEND_EVENT_DEBOUNCE_MS = 500

// ---------------------------------------------------------------------------
// Markdown rendering: math components + stable plugin arrays
// ---------------------------------------------------------------------------

/**
 * Render inline math ($...$) via Temml UMD.
 * remark-math produces <code class="language-math math-inline"> elements.
 */
function MathInline({ children }: { children?: React.ReactNode }) {
  const latex = String(children ?? "")
  const html = renderLatexToString(latex, false, "")
  if (html) return <span dangerouslySetInnerHTML={{ __html: html }} />
  return <code>{latex}</code>
}

/**
 * Render display math ($$...$$) via Temml UMD.
 * remark-math produces <div class="math math-display"> wrapping <code class="language-math math-display">.
 * But react-markdown maps the inner <code> with className including "math-display".
 */
function MathDisplay({ children }: { children?: React.ReactNode }) {
  const latex = String(children ?? "")
  const html = renderLatexToString(latex, true, "")
  if (html) return <div dangerouslySetInnerHTML={{ __html: html }} />
  return <pre>{latex}</pre>
}

/** Stable plugin arrays — defined at module level to avoid re-creating on every render */
const remarkPlugins = [remarkGfm, remarkMath]

/**
 * Error boundary for MarkdownRenderer — falls back to raw <pre> display
 * if react-markdown throws during parsing/rendering.
 */
class MarkdownErrorBoundary extends Component<
  { fallback: string; children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  render() {
    if (this.state.hasError) {
      return <pre className="reader-content text-foreground whitespace-pre-wrap text-sm font-mono">{this.props.fallback}</pre>
    }
    return this.props.children
  }
}

// ---------------------------------------------------------------------------
// Filter categories
// ---------------------------------------------------------------------------

const READER_CATEGORIES: readonly FilterCategory<"text" | "author" | "date">[] = [
  { type: "text", label: "Text", hint: "title or content" },
  { type: "author", label: "Author", hint: "name or @handle" },
  { type: "date", label: "Date", hint: "yesterday, march 15" },
] as const
const READER_DATE_TYPES = new Set(["date"] as const)

// ---------------------------------------------------------------------------
// ReaderPage
// ---------------------------------------------------------------------------

export function ReaderPage() {
  const [articles, setArticles] = useState<ArticleListItem[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedArticle, setSelectedArticle] = useState<ArticleListItem | null>(null)
  const [versionsMap, setVersionsMap] = useState<Record<string, ArticleListItem[]>>({})
  const manualVersionRef = useRef<ArticleListItem | null>(null)
  const [loading, setLoading] = useState(false)
  const [articleLoading, setArticleLoading] = useState(false)
  const [viewModes, setViewModes] = useState<Record<string, "raw" | "markdown">>({})
  const [urlViewMode, setUrlViewMode] = useState<"raw" | "markdown">(() => {
    if (typeof window === "undefined") return "raw"
    const view = new URLSearchParams(window.location.search).get("view")
    return view === "markdown" ? "markdown" : "raw"
  })
  const [filterTokens, setFilterTokens] = useState<FilterToken[]>([])
  const [liveText, setLiveText] = useState("")
  const filterTokensRef = useRef(filterTokens)
  filterTokensRef.current = filterTokens
  const liveTextRef = useRef(liveText)
  liveTextRef.current = liveText
  const fetchGenRef = useRef(0)
  const selectedArticleRef = useRef<ArticleListItem | null>(null)
  selectedArticleRef.current = selectedArticle
  const versionParamResolvedRef = useRef(false)
  const [dateWindowDays, setDateWindowDays] = useState(3)
  const [hasMore, setHasMore] = useState(true)

  // Build API filter params from tokens
  function buildFilterParams(toks: FilterToken[], live: string): { q?: string; author?: string; dateFrom?: string; dateTo?: string } {
    const textParts: string[] = []
    let author: string | undefined
    let dateFrom: string | undefined
    let dateTo: string | undefined
    for (const t of toks) {
      if (t.type === "text") {
        textParts.push(t.value)
      } else if (t.type === "author") {
        author = t.value
      } else if (t.type === "date" && t.dateFrom && t.dateTo) {
        dateFrom = t.dateFrom
        dateTo = t.dateTo
      }
    }
    if (live.trim()) textParts.push(live.trim())
    return { q: textParts.length > 0 ? textParts.join(" ") : undefined, author, dateFrom, dateTo }
  }

  // Fetch article list
  const fetchArticles = useCallback(async (isPoll = false) => {
    const gen = ++fetchGenRef.current
    if (!isPoll) setLoading(true)

    const { q, author, dateFrom: filterDateFrom, dateTo } = buildFilterParams(filterTokensRef.current, liveTextRef.current)
    try {
      const params = new URLSearchParams({ limit: "100" })
      if (q) params.set("q", q)
      if (author) params.set("author", author)
      // Apply date window when no explicit date filter is set
      if (filterDateFrom) {
        params.set("dateFrom", filterDateFrom)
      } else {
        const windowDateFrom = new Date(Date.now() - dateWindowDays * 86400_000).toISOString()
        params.set("dateFrom", windowDateFrom)
      }
      if (dateTo) params.set("dateTo", dateTo)
      const resp = await fetch(`/api/v1/articles?${params}`)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const data = await resp.json()
      if (gen !== fetchGenRef.current) return

      const list: ArticleListItem[] = data.articles || []
      setArticles(list)

      // If we loaded nothing, there's nothing more to fetch
      if (list.length === 0) {
        setHasMore(false)
      }

      // Auto-select: check URL param first, otherwise pick first article
      if (!isPoll) {
        const urlParams = new URLSearchParams(window.location.search)
        const idParam = urlParams.get("id")
        if (idParam && list.find((a) => a.id === idParam)) {
          setSelectedId(idParam)
        } else if (list.length > 0 && !selectedId) {
          setSelectedId(list[0]!.id)
        }
      } else {
        // Poll: if the selected article is no longer the latest (new version appended),
        // auto-select the new latest for the same source_key
        if (selectedId && !list.find((a) => a.id === selectedId)) {
          const prevSourceKey = selectedArticleRef.current?.source_key
          const replacement = (prevSourceKey && list.find((a) => a.source_key === prevSourceKey)) || list[0] || null
          if (replacement) {
            setSelectedId(replacement.id)
            const url = new URL(window.location.href)
            url.searchParams.set("id", replacement.id)
            window.history.replaceState({}, "", url.toString())
          }
        }
      }
    } catch {
      // Graceful degradation — keep existing list
    } finally {
      if (gen === fetchGenRef.current) setLoading(false)
    }
  }, [selectedId, dateWindowDays])

  // Fetch single article for the main content area
  const fetchArticle = useCallback(async (id: string) => {
    setArticleLoading(true)
    try {
      const resp = await fetch(`/api/v1/articles/${encodeURIComponent(id)}`)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const data = await resp.json()
      const art = data.article || null
      setSelectedArticle(art)
      if (art && !art.markdown) setViewModes((prev) => ({ ...prev, [art.id]: "raw" }))
    } catch {
      setSelectedArticle(null)
    } finally {
      setArticleLoading(false)
    }
  }, [])

  // Load more articles (expand date window by 3 days)
  const handleLoadMore = useCallback(() => {
    setDateWindowDays((prev) => prev + 3)
    setHasMore(true)
  }, [])

  // ── Virtualizer for article list sidebar ──
  const scrollAreaRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: articles.length,
    getScrollElement: () => scrollAreaRef.current,
    estimateSize: () => 72,
    overscan: 5,
  })

  // Scroll sentinel: auto-trigger handleLoadMore when near the bottom
  const virtualItems = virtualizer.getVirtualItems()
  const lastItem = virtualItems[virtualItems.length - 1]
  useEffect(() => {
    if (!lastItem) return
    if (lastItem.index >= articles.length - 5 && hasMore && !loading && !buildFilterParams(filterTokens, liveText).dateFrom) {
      handleLoadMore()
    }
  }, [lastItem?.index, articles.length, hasMore, loading, filterTokens, liveText, handleLoadMore])

  // Re-fetch when dateWindowDays changes (load more)
  useEffect(() => {
    if (dateWindowDays > 3) {
      fetchArticles()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateWindowDays])

  // On mount: fetch article list and handle URL param
  useEffect(() => {
    fetchArticles()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-fetch when filter changes (debounced 200ms) — also reset date window and hasMore
  const filterDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (filterDebounceRef.current) clearTimeout(filterDebounceRef.current)
    filterDebounceRef.current = setTimeout(() => {
      setHasMore(true)
      fetchArticles()
    }, 200)
    return () => { if (filterDebounceRef.current) clearTimeout(filterDebounceRef.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterTokens, liveText])

  // When selectedId changes, fetch the full article (unless manually set via version dropdown)
  const articlesRef = useRef(articles)
  articlesRef.current = articles
  useEffect(() => {
    if (selectedId) {
      if (manualVersionRef.current) {
        setSelectedArticle(manualVersionRef.current)
        manualVersionRef.current = null
      } else {
        fetchArticle(selectedId)
      }
    } else {
      setSelectedArticle(null)
    }
  }, [selectedId, fetchArticle])

  // Fetch versions for all multi-version articles
  const fetchedVersionKeysRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    for (const article of articles) {
      if ((article.version_count ?? 1) <= 1) continue
      const sourceKey = article.source_key || article.id
      if (fetchedVersionKeysRef.current.has(sourceKey)) continue
      fetchedVersionKeysRef.current.add(sourceKey)
      fetch(`/api/v1/articles/${encodeURIComponent(sourceKey)}/versions`)
        .then((r) => r.ok ? r.json() : null)
        .then((data) => {
          if (data?.versions) {
            setVersionsMap(prev => ({ ...prev, [sourceKey]: data.versions }))
          }
        })
        .catch(() => {
          // Allow retry on next article list refresh
          fetchedVersionKeysRef.current.delete(sourceKey)
        })
    }
  }, [articles])

  // Resolve version URL param once versionsMap is populated
  useEffect(() => {
    if (versionParamResolvedRef.current || !selectedId) return
    const params = new URLSearchParams(window.location.search)
    const versionParam = params.get("version")
    if (!versionParam) { versionParamResolvedRef.current = true; return }

    // Find the source_key for the currently selected article
    const sourceKey = articles.find((a) => a.id === selectedId)?.source_key || selectedId
    const versions = versionsMap[sourceKey]
    if (!versions) return // not loaded yet — will retry on next versionsMap change

    const match = versions.find((v) => v.id === versionParam)
    versionParamResolvedRef.current = true
    if (match) {
      setSelectedArticle(match)
    }
    // If no match, fall through to default (latest version)
  }, [versionsMap, selectedId, articles])

  // backend event — refresh articles when new clips arrive or markdown jobs complete
  useEffect(() => {
    let backendEventDebounce: ReturnType<typeof setTimeout> | null = null

    const handleBackendEvent = () => {
      if (backendEventDebounce) clearTimeout(backendEventDebounce)
      backendEventDebounce = setTimeout(() => {
        fetchArticles(true)
      }, BACKEND_EVENT_DEBOUNCE_MS)
    }

    // data-changed: emitted when articles change (future-proofing)
    window.addEventListener("backend:data-changed", handleBackendEvent)

    // jobs-updated: emitted on job start/complete — refresh when web_clip_markdown finishes
    const handleJobsUpdated = (e: Event) => {
      try {
        const detail = (e as CustomEvent<unknown>).detail
        const payload = typeof detail === "string"
          ? JSON.parse(detail) as { jobId?: string }
          : detail as { jobId?: string } | null
        if (payload?.jobId === "web_clip_markdown") handleBackendEvent()
      } catch { /* ignore malformed */ }
    }
    window.addEventListener("backend:jobs-updated", handleJobsUpdated)

    return () => {
      window.removeEventListener("backend:data-changed", handleBackendEvent)
      window.removeEventListener("backend:jobs-updated", handleJobsUpdated)
      if (backendEventDebounce) clearTimeout(backendEventDebounce)
    }
  }, [fetchArticles])

  // Handle sidebar card click
  const handleSelect = useCallback((id: string) => {
    setSelectedId(id)
    // Update URL without triggering navigation; clear version param (revert to latest)
    const url = new URL(window.location.href)
    url.searchParams.set("id", id)
    url.searchParams.delete("version")
    window.history.replaceState({}, "", url.toString())
  }, [])

  // Update view mode for an article and sync to URL query string
  const setViewMode = useCallback((articleId: string, mode: "raw" | "markdown") => {
    setViewModes((p) => ({ ...p, [articleId]: mode }))
    // Do NOT update urlViewMode — it is the initial global default from URL, not a per-article toggle target
    const url = new URL(window.location.href)
    url.searchParams.set("view", mode)
    window.history.replaceState({}, "", url.toString())
  }, [])

  // Parse the selected article's collect_data
  const selectedMeta = selectedArticle
    ? parseCollectData(selectedArticle.collect_data)
    : null

  // Sanitize content and render math inline (memoized to avoid re-running on every render)
  const sanitizedRef = useRef<{ articleId: string; html: string } | null>(null)
  if (selectedArticle && sanitizedRef.current?.articleId !== selectedArticle.id) {
    const html = sanitizeArticleHtml(selectedArticle.content, selectedMeta?.url)
    sanitizedRef.current = { articleId: selectedArticle.id, html }
  }
  const sanitizedHtml = sanitizedRef.current?.html ?? ""
  const selectedArticleId = selectedArticle?.id

  // Hide broken images (external URLs may be stale/blocked by CORS)
  useEffect(() => {
    if (!selectedArticleId) return
    const container = document.querySelector(".reader-content")
    if (!container) return
    for (const img of Array.from(container.querySelectorAll("img"))) {
      img.addEventListener("error", () => { (img as HTMLElement).style.display = "none" })
    }
  }, [selectedArticleId])

  // Open links in external browser (Electron: window.open triggers setWindowOpenHandler → shell.openExternal)
  useEffect(() => {
    if (!selectedArticleId) return
    const container = document.querySelector(".reader-content")
    if (!container) return
    const handler = (e: Event) => {
      const anchor = (e.target as HTMLElement).closest("a")
      if (!anchor) return
      const href = anchor.getAttribute("href")
      if (!href || href.startsWith("#") || href.startsWith("javascript:")) return
      e.preventDefault()
      window.open(href, "_blank")
    }
    container.addEventListener("click", handler)
    return () => container.removeEventListener("click", handler)
  }, [selectedArticleId])

  return (
    <div className="flex flex-col h-full">
      {/* Nav bar */}
      <header className="sticky top-0 z-10 border-b border-border flex items-center gap-1.5 shrink-0 bg-muted px-4 py-1.5">
        <span className="text-xs font-medium text-foreground">Reader</span>
        <div className="flex-1" />
        {articles.length > 0 && (
          <span className="whitespace-nowrap text-[11px] text-muted-foreground">
            {articles.length} articles
          </span>
        )}
        <FilterBar
          categories={READER_CATEGORIES}
          tokens={filterTokens}
          onTokensChange={setFilterTokens}
          onLiveText={setLiveText}
          dateTypes={READER_DATE_TYPES}
          inputId="searchInput-reader"
          placeholder="Filter articles..."
          className="min-w-[200px]"
          style={{ width: 280 }}
        />
      </header>

      <div className="flex flex-1 min-h-0">
      {/* Sidebar */}
      <div ref={scrollAreaRef} className="w-80 border-r border-border overflow-y-auto flex-shrink-0">
        {loading && articles.length === 0 ? (
          <div className="flex items-center justify-center py-16">
            <span className="text-sm text-muted-foreground animate-pulse">Loading...</span>
          </div>
        ) : articles.length === 0 ? (
          <div className="flex items-center justify-center py-16">
            <span className="text-sm text-muted-foreground">No articles collected yet</span>
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const article = articles[virtualRow.index]
              if (!article) return null
              const meta = parseCollectData(article.collect_data)
              const isActive = article.id === selectedId
              const cardArticle = isActive && selectedArticle ? selectedArticle : article
              const dateKey = article.created_at ? article.created_at.slice(0, 10) : ""
              const prevDateKey = virtualRow.index > 0 && articles[virtualRow.index - 1]?.created_at
                ? articles[virtualRow.index - 1]!.created_at.slice(0, 10)
                : ""
              const showDateHeader = dateKey && dateKey !== prevDateKey
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
                {showDateHeader && (
                  <div className="sticky top-0 z-[1] px-4 py-1.5 text-[11px] font-semibold text-ring bg-background border-b border-border">
                    {dateKey}
                  </div>
                )}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => handleSelect(article.id)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") handleSelect(article.id) }}
                  className={`text-left px-4 py-3 border-b border-border transition-colors cursor-pointer hover:bg-muted/50 ${
                    isActive ? "bg-muted" : ""
                  }`}
                >
                  {meta.handle && (
                    <div className="text-xs text-muted-foreground truncate mb-0.5">
                      {meta.handle}
                    </div>
                  )}
                  <div className="text-sm text-foreground font-medium line-clamp-2 leading-snug">
                    {meta.title || article.id}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
                    {(() => {
                      const cardVersions = versionsMap[article.source_key || article.id] || []
                      return cardVersions.length > 1 ? (
                        <select
                          value={isActive ? (selectedArticle?.id ?? "") : article.id}
                          onChange={(e) => {
                            e.stopPropagation()
                            const v = cardVersions.find((ver) => ver.id === e.target.value)
                            if (v) {
                              if (isActive) {
                                setSelectedArticle(v)
                              } else {
                                manualVersionRef.current = v
                                handleSelect(article.id)
                              }
                              // Update URL with version param
                              const url = new URL(window.location.href)
                              url.searchParams.set("id", article.id)
                              url.searchParams.set("version", v.id)
                              window.history.replaceState({}, "", url.toString())
                            }
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className="bg-muted border border-border rounded px-1.5 py-0.5 text-xs text-foreground outline-none"
                        >
                          {cardVersions.map((v, i) => (
                            <option key={v.id} value={v.id}>
                              {formatDate(v.created_at)}{i === 0 ? " (latest)" : ""}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span>{formatDate(article.created_at)}</span>
                      )
                    })()}
                    {(() => {
                      const hasMd = isActive ? !!(selectedArticle?.markdown) : !!(article.markdown)
                      const cardMode = viewModes[article.id] ?? (hasMd ? urlViewMode : "raw")
                      return (
                        <div
                          className={`inline-flex h-6 items-center rounded-md bg-muted p-0.5 ml-auto ${hasMd ? "text-muted-foreground" : "text-muted-foreground/40"}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setViewMode(article.id, "raw"); if (!isActive) handleSelect(article.id) }}
                            className={`inline-flex items-center justify-center rounded-sm px-1.5 py-0.5 text-[10px] font-medium transition-all ${
                              cardMode === "raw"
                                ? "bg-background text-foreground shadow-sm"
                                : hasMd ? "hover:text-foreground" : ""
                            }`}
                          >
                            Raw
                          </button>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); if (hasMd) { setViewMode(article.id, "markdown"); if (!isActive) handleSelect(article.id) } }}
                            className={`inline-flex items-center justify-center rounded-sm px-1.5 py-0.5 text-[10px] font-medium transition-all ${
                              cardMode === "markdown"
                                ? "bg-background text-foreground shadow-sm"
                                : hasMd
                                  ? "hover:text-foreground"
                                  : "cursor-not-allowed"
                            }`}
                            disabled={!hasMd}
                          >
                            MD
                          </button>
                        </div>
                      )
                    })()}
                  </div>
                  {(article.source_key || cardArticle.markdown_full_path) && (
                    <div className="flex items-center gap-1 mt-1">
                      {article.source_key && (
                        <>
                          <span className="text-[10px] text-muted-foreground/60 font-mono truncate">
                            {article.source_key}
                          </span>
                          <span
                            role="button"
                            tabIndex={0}
                            className="flex-shrink-0 cursor-pointer text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                            title="Copy source_key"
                            onClick={(e) => {
                              e.stopPropagation()
                              navigator.clipboard.writeText(article.source_key ?? "")
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.stopPropagation()
                                navigator.clipboard.writeText(article.source_key ?? "")
                              }
                            }}
                          >
                            <Icon icon="solar:copy-bold" width={12} height={12} />
                          </span>
                        </>
                      )}
                      {cardArticle.markdown_full_path && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); window.electronAPI?.showInFolder(cardArticle.markdown_full_path!) }}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/15 text-green-400 font-medium hover:bg-green-500/25"
                          title="Reveal markdown file in Finder"
                        >
                          Local
                        </button>
                      )}
                    </div>
                  )}
                </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-y-auto">
        {articleLoading ? (
          <div className="flex items-center justify-center py-16">
            <span className="text-sm text-muted-foreground animate-pulse">Loading article...</span>
          </div>
        ) : !selectedArticle ? (
          <div className="flex items-center justify-center py-16">
            <span className="text-sm text-muted-foreground">
              {articles.length === 0 ? "No articles collected yet" : "Select an article from the sidebar"}
            </span>
          </div>
        ) : (
          <article className="max-w-3xl mx-auto px-8 py-6">
            {/* Header image (first image from article, shown above title like on X) */}
            {selectedArticle.media_data && selectedArticle.media_data.length > 0 && (() => {
              try {
                const firstMedia = JSON.parse(selectedArticle.media_data[0]);
                const imgUrl = firstMedia.url || `/api/v1/articles/${encodeURIComponent(selectedArticle.id)}/image/0`;
                return (
                  <div className="mb-4 rounded-lg overflow-hidden">
                    <img src={imgUrl} alt="" className="w-full max-h-[400px] object-cover" loading="lazy" />
                  </div>
                );
              } catch { return null; }
            })()}

            {/* Article header */}
            <header className="mb-6 pb-4 border-b border-border">
              {selectedMeta?.title && (
                <h1 className="text-xl font-semibold text-foreground leading-tight mb-2">
                  {selectedMeta.url ? (
                    <a href={selectedMeta.url} target="_blank" rel="noopener noreferrer" className="hover:text-primary hover:underline">
                      {selectedMeta.title}
                    </a>
                  ) : selectedMeta.title}
                </h1>
              )}
              {(selectedMeta?.avatarUrl || selectedMeta?.displayName || selectedMeta?.handle) ? (
                <div className="flex items-center gap-2 text-sm">
                  {selectedMeta.avatarUrl && (
                    <img
                      src={selectedMeta.avatarUrl}
                      className="w-7 h-7 rounded-full shrink-0"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = "none" }}
                      alt=""
                    />
                  )}
                  {selectedMeta.displayName && (
                    <span className="font-medium text-foreground">{selectedMeta.displayName}</span>
                  )}
                  {selectedMeta.handle && (
                    <a href={`https://x.com/${selectedMeta.handle.replace(/^@/, "")}`} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-primary hover:underline">
                      {selectedMeta.handle.startsWith("@") ? selectedMeta.handle : `@${selectedMeta.handle}`}
                    </a>
                  )}
                  {(selectedMeta.handle || selectedMeta.displayName) && (selectedMeta.tweetDate || selectedArticle.created_at) && (
                    <span className="text-muted-foreground opacity-40">&middot;</span>
                  )}
                  {(() => {
                    const dateStr = selectedMeta.tweetDate || selectedArticle.created_at
                    const sv = versionsMap[selectedArticle.source_key || selectedArticle.id] || []
                    return sv.length <= 1 && dateStr ? (
                      <span className="text-muted-foreground">{formatDate(dateStr)}</span>
                    ) : null
                  })()}
                </div>
              ) : (
                <div className="flex items-center gap-3 text-sm text-muted-foreground">
                  {selectedMeta?.author && selectedMeta.author !== selectedMeta.handle && (
                    <span className="font-medium text-foreground">{selectedMeta.author}</span>
                  )}
                  {selectedMeta?.handle && (
                    <a href={`https://x.com/${selectedMeta.handle.replace(/^@/, "")}`} target="_blank" rel="noopener noreferrer" className="hover:text-primary hover:underline">
                      {selectedMeta.handle.startsWith("@") ? selectedMeta.handle : `@${selectedMeta.handle}`}
                    </a>
                  )}
                  {(() => {
                    const sv = versionsMap[selectedArticle.source_key || selectedArticle.id] || []
                    return sv.length <= 1 ? (
                      <>
                        {selectedMeta?.handle && selectedArticle.created_at && (
                          <span className="opacity-40">&middot;</span>
                        )}
                        {selectedArticle.created_at && (
                          <span>{formatDate(selectedArticle.created_at)}</span>
                        )}
                      </>
                    ) : null
                  })()}
                </div>
              )}
            </header>

            {/* Article content */}
            {(viewModes[selectedArticle.id] ?? urlViewMode) === "markdown" && selectedArticle.markdown ? (
              <MarkdownErrorBoundary fallback={selectedArticle.markdown}>
                <div className="reader-content text-foreground">
                  <ReactMarkdown
                    remarkPlugins={remarkPlugins}
                    components={{
                      // Math: remark-math produces <code> with className "math-inline" or "math-display"
                      code: (props: any) => {
                        const className = String(props.className ?? "")
                        if (className.includes("math-inline")) return <MathInline>{props.children}</MathInline>
                        if (className.includes("math-display")) return <MathDisplay>{props.children}</MathDisplay>
                        return <code {...props} />
                      },
                      // Images: resolve relative paths to the API endpoint
                      img: (props: ImgHTMLAttributes<HTMLImageElement>) => {
                        let src = props.src ?? ""
                        if (src && !src.startsWith("http://") && !src.startsWith("https://") && !src.startsWith("data:")) {
                          const filename = src.split("/").pop() ?? ""
                          const mediaData = selectedArticle.media_data ?? []
                          for (let i = 0; i < mediaData.length; i++) {
                            try {
                              const meta = JSON.parse(mediaData[i]!)
                              if (meta.type === "image" && meta.filename === filename) {
                                src = `/api/v1/articles/${encodeURIComponent(selectedArticle.id)}/image/${i}`
                                break
                              }
                            } catch { /* skip malformed */ }
                          }
                        }
                        return (
                          <img
                            {...props}
                            src={src}
                            loading="lazy"
                            onError={(e) => { (e.target as HTMLElement).style.display = "none" }}
                          />
                        )
                      },
                    }}
                  >
                    {selectedArticle.markdown}
                  </ReactMarkdown>
                </div>
              </MarkdownErrorBoundary>
            ) : (
              <div
                className="reader-content text-foreground"
                dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
              />
            )}
          </article>
        )}
      </div>

      {/* Inline styles for article prose rendering */}
      <style>{`
        .reader-content {
          font-size: 15px;
          line-height: 1.7;
          word-wrap: break-word;
          overflow-wrap: break-word;
        }
        .reader-content h1 {
          font-size: 1.75em;
          font-weight: 700;
          margin-top: 1.5em;
          margin-bottom: 0.5em;
          line-height: 1.3;
          color: var(--foreground);
        }
        .reader-content h2 {
          font-size: 1.4em;
          font-weight: 600;
          margin-top: 1.4em;
          margin-bottom: 0.4em;
          line-height: 1.3;
          color: var(--foreground);
        }
        .reader-content h3 {
          font-size: 1.15em;
          font-weight: 600;
          margin-top: 1.2em;
          margin-bottom: 0.3em;
          line-height: 1.4;
          color: var(--foreground);
        }
        .reader-content p {
          margin-bottom: 1em;
        }
        .reader-content a {
          color: var(--ring);
          text-decoration: underline;
          text-underline-offset: 2px;
        }
        .reader-content a:hover {
          opacity: 0.8;
        }
        .reader-content ul, .reader-content ol {
          margin-bottom: 1em;
          padding-left: 1.5em;
        }
        .reader-content ul {
          list-style: disc;
        }
        .reader-content ol {
          list-style: decimal;
        }
        .reader-content li {
          margin-bottom: 0.35em;
        }
        .reader-content blockquote {
          border-left: 3px solid var(--border);
          padding-left: 1em;
          margin: 1em 0;
          color: var(--muted-foreground);
          font-style: italic;
        }
        .reader-content pre {
          background: var(--muted);
          border: 1px solid var(--border);
          border-radius: 6px;
          padding: 12px 16px;
          overflow-x: auto;
          margin: 1em 0;
          font-size: 0.9em;
          line-height: 1.5;
        }
        .reader-content code {
          background: var(--muted);
          border-radius: 3px;
          padding: 2px 5px;
          font-size: 0.9em;
        }
        .reader-content pre code {
          background: none;
          padding: 0;
          border-radius: 0;
        }
        .reader-content img {
          max-width: 100%;
          height: auto;
          border-radius: 6px;
          margin: 1em 0;
        }
        .reader-content a:has(img) {
          text-decoration: none;
          color: inherit;
          display: block;
        }
        .reader-content a.video-placeholder {
          display: block;
          text-decoration: none;
          color: inherit;
          margin: 1em 0;
        }
        .reader-content .video-placeholder-inner {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 12px;
          padding: 24px 16px;
          background: var(--muted);
          border: 1px solid var(--border);
          border-radius: 8px;
          color: var(--muted-foreground);
          font-size: 14px;
        }
        .reader-content a.video-placeholder:hover .video-placeholder-inner span {
          text-decoration: underline;
        }
        .reader-content .video-placeholder-caption {
          margin-top: 4px;
          font-size: 12px;
          color: var(--muted-foreground);
          opacity: 0.7;
        }
        .reader-content table {
          width: 100%;
          border-collapse: collapse;
          margin: 1em 0;
        }
        .reader-content th, .reader-content td {
          border: 1px solid var(--border);
          padding: 8px 12px;
          text-align: left;
        }
        .reader-content th {
          background: var(--muted);
          font-weight: 600;
        }
        .reader-content hr {
          border: none;
          border-top: 1px solid var(--border);
          margin: 1.5em 0;
        }
        /* Math: placeholder spans become block containers for display equations */
        .reader-content [data-math-idx] {
          display: block;
          text-align: center;
          margin: 1em 0;
        }
        .reader-content math {
          font-size: 1.1em;
        }
        .reader-content math[display="block"] {
          display: block math;
          margin: 0 auto;
        }
      `}</style>
      </div>
    </div>
  )
}
