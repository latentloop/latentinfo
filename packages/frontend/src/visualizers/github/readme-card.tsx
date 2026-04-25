import React, { type ComponentPropsWithoutRef, memo, Suspense, useCallback, useEffect, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { darkTheme } from "@uiw/react-json-view/dark"
import { Icon } from "@iconify/react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import type { GithubItem } from "./types"

const JsonView = React.lazy(() => import("@uiw/react-json-view"))

type ViewMode = "readme" | "data"
type MarkdownAnchorProps = ComponentPropsWithoutRef<"a"> & { node?: unknown }
type MarkdownImageProps = ComponentPropsWithoutRef<"img"> & { node?: unknown }
const remarkPlugins = [remarkGfm]
const README_PREVIEW_CHARS = 1800
const detailCache = new Map<string, GithubItem>()

async function fetchDetail(itemId: string): Promise<GithubItem | null> {
  const cached = detailCache.get(itemId)
  if (cached) return cached
  try {
    const resp = await fetch(`/api/v1/github/${encodeURIComponent(itemId)}`)
    if (!resp.ok) return null
    const data = await resp.json() as { item?: GithubItem }
    if (data.item) {
      detailCache.set(itemId, data.item)
      return data.item
    }
  } catch { /* ignore */ }
  return null
}

function formatDate(iso: string): string {
  if (!iso) return "-"
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, "0")
    const day = String(d.getDate()).padStart(2, "0")
    return `${y}-${m}-${day}`
  } catch {
    return iso
  }
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "0"
  return new Intl.NumberFormat(undefined, { notation: n >= 10_000 ? "compact" : "standard" }).format(n)
}

function readmePreview(markdown: string): string {
  const trimmed = markdown.trim()
  if (trimmed.length <= README_PREVIEW_CHARS) return trimmed
  return trimmed.slice(0, README_PREVIEW_CHARS).trimEnd()
}

function normalizeImageSource(value: string | undefined): string {
  return (value || "").trim().replace(/^<|>$/g, "")
}

function resolveReadmeImageUrl(raw: GithubItem["rawData"], src: string): string {
  const source = normalizeImageSource(src)
  if (!source || /^(data|blob):/i.test(source)) return source

  try {
    if (/^https?:\/\//i.test(source)) return source
    if (source.startsWith("//")) return `https:${source}`
    if (source.startsWith("/")) return new URL(source, "https://github.com").href
    if (raw.rawUrl) return new URL(source, raw.rawUrl).href
    return new URL(source, raw.url.endsWith("/") ? raw.url : `${raw.url}/`).href
  } catch {
    return source
  }
}

function resolveReadmeImageSrc(raw: GithubItem["rawData"], src: string | undefined): string {
  const source = normalizeImageSource(src)
  const resolved = resolveReadmeImageUrl(raw, source)
  if (raw.readmeImagesLoaded === false) return ""
  const match = (raw.readmeImages || []).find((image) => {
    return image.originalUrl === source ||
      image.resolvedUrl === source ||
      image.originalUrl === resolved ||
      image.resolvedUrl === resolved
  })
  return match?.dataUri || resolved
}

function resolveReadmeLinkHref(raw: GithubItem["rawData"], href: string | undefined): string | undefined {
  const source = (href || "").trim()
  if (!source) return undefined
  if (/^(https?:|mailto:|tel:)/i.test(source)) return source
  if (source.startsWith("//")) return `https:${source}`
  if (source.startsWith("#")) return `${raw.htmlUrl || raw.url}${source}`

  try {
    if (source.startsWith("/")) return new URL(source, "https://github.com").href
    const branch = raw.defaultBranch || "HEAD"
    const readmeDir = raw.readmePath.includes("/")
      ? raw.readmePath.slice(0, raw.readmePath.lastIndexOf("/") + 1)
      : ""
    return new URL(source, `https://github.com/${raw.owner}/${raw.repo}/blob/${branch}/${readmeDir}`).href
  } catch {
    return source
  }
}

class MarkdownErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: string },
  { hasError: boolean }
> {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidUpdate(prevProps: { fallback: string }) {
    if (this.state.hasError && prevProps.fallback !== this.props.fallback) {
      this.setState({ hasError: false })
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <pre className="text-xs text-foreground/80 mt-3 leading-relaxed whitespace-pre-wrap max-h-[340px] overflow-y-auto rounded-md bg-background/60 border border-border p-2">
          {this.props.fallback}
        </pre>
      )
    }
    return this.props.children
  }
}

export const ReadmeCard = memo(function ReadmeCard({ item }: { item: GithubItem }) {
  const { info } = item
  const [viewMode, setViewMode] = useState<ViewMode>("readme")
  const [expanded, setExpanded] = useState(false)
  const [detailItem, setDetailItem] = useState<GithubItem | null>(() => detailCache.get(item.info.id) ?? null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const displayItem = detailItem || item
  const raw = displayItem.rawData
  const fullMarkdown = (raw.readmeMarkdown || raw.readmeText).trim()
  const markdown = expanded ? fullMarkdown : readmePreview(fullMarkdown)
  const canExpand = !expanded && (raw.readmeTruncated || fullMarkdown.length > README_PREVIEW_CHARS)

  useEffect(() => {
    setExpanded(false)
    setDetailItem(detailCache.get(item.info.id) ?? null)
    setLoadingDetail(false)
  }, [item.info.id])

  const ensureDetail = useCallback(async () => {
    if (detailItem) return detailItem
    setLoadingDetail(true)
    const next = await fetchDetail(info.id)
    if (next) setDetailItem(next)
    setLoadingDetail(false)
    return next
  }, [detailItem, info.id])

  const handleViewModeChange = useCallback((mode: ViewMode) => {
    setViewMode(mode)
    if (mode === "data") {
      void ensureDetail()
    }
  }, [ensureDetail])

  const handleExpand = useCallback(async () => {
    if (raw.readmeTruncated || raw.readmeImagesLoaded === false) {
      const next = await ensureDetail()
      if (!next) {
        toast.error("Could not load full README")
        return
      }
    }
    setExpanded(true)
  }, [ensureDetail, raw.readmeImagesLoaded, raw.readmeTruncated])

  const handleCopy = useCallback(async () => {
    const next = await ensureDetail()
    const source = next?.rawData || raw
    navigator.clipboard.writeText(source.readmeMarkdown || source.readmeText)
    toast.success("Copied README markdown")
  }, [ensureDetail, raw])

  const handleCardKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
    const el = cardRef.current
    const parent = el?.parentElement
    if (!el || !parent) return
    const cards = parent.querySelectorAll(":scope > .github-card")
    const idx = Array.from(cards).indexOf(el)
    if (idx === -1) return
    const next = e.key === "ArrowDown" ? cards[idx + 1] : cards[idx - 1]
    if (next instanceof HTMLElement) {
      e.preventDefault()
      next.focus()
      next.scrollIntoView({ block: "nearest" })
    }
  }, [])

  return (
    <div
      ref={cardRef}
      tabIndex={0}
      onKeyDown={handleCardKeyDown}
      className="github-card border border-border rounded-lg overflow-hidden hover:border-ring focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring relative outline-none"
      style={{ padding: "10px 12px", background: "#0d1117" }}
    >
      <div className="absolute top-1.5 right-1.5 z-10" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-col items-stretch gap-1">
          <div className="inline-flex bg-gray-700/80 rounded-md p-1">
            {(["readme", "data"] as ViewMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => handleViewModeChange(mode)}
                className={cn(
                  "px-3 py-1.5 rounded-[2px] text-xs font-medium transition-all leading-none",
                  viewMode === mode
                    ? "bg-white/15 text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {mode}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="rounded bg-gray-700/70 px-2 py-1 text-xs font-medium leading-none text-muted-foreground hover:bg-gray-700 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            title="Copy README markdown"
            onClick={handleCopy}
          >
            copy
          </button>
        </div>
      </div>

      {viewMode === "data" ? (
        <div style={{ borderRadius: 8, padding: "4px 0", marginTop: 20 }} className="max-h-[420px] overflow-y-auto overflow-x-hidden">
          <Suspense fallback={<div className="text-xs text-muted-foreground p-2">Loading...</div>}>
            <JsonView
              value={displayItem as unknown as object}
              style={{ ...darkTheme, wordBreak: "break-all", wordWrap: "break-word", whiteSpace: "pre-wrap" }}
              displayDataTypes={false}
              enableClipboard={true}
              shortenTextAfterLength={0}
            />
          </Suspense>
        </div>
      ) : (
        <>
          <a
            href={raw.url}
            target="_blank"
            rel="noopener"
            className="text-sm font-semibold text-foreground hover:text-primary leading-snug block pr-32"
          >
            {raw.fullName}
          </a>

          {raw.description ? (
            <p className="text-xs text-muted-foreground mt-1 pr-32">{raw.description}</p>
          ) : null}

          <div className="flex items-center gap-2 mt-2 flex-wrap text-[10px]">
            {raw.language ? (
              <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium">{raw.language}</span>
            ) : null}
            {raw.defaultBranch ? (
              <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium">{raw.defaultBranch}</span>
            ) : null}
            <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium">
              {formatNumber(raw.stars)} stars
            </span>
            <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium">
              {formatNumber(raw.forks)} forks
            </span>
            <a
              href={raw.htmlUrl}
              target="_blank"
              rel="noopener"
              className="px-1.5 py-0.5 rounded bg-primary/15 text-primary font-medium hover:bg-primary/25"
            >
              README
            </a>
            {raw.rawUrl ? (
              <a
                href={raw.rawUrl}
                target="_blank"
                rel="noopener"
                className="px-1.5 py-0.5 rounded bg-primary/15 text-primary font-medium hover:bg-primary/25"
              >
                Raw
              </a>
            ) : null}
          </div>

          <MarkdownErrorBoundary fallback={markdown}>
            <div className="github-readme-content text-foreground/85 mt-3 h-[300px] overflow-y-auto rounded-md bg-background/60 border border-border p-2 relative">
              <ReactMarkdown
                remarkPlugins={remarkPlugins}
                components={{
                  a: ({ node: _node, href, ...props }: MarkdownAnchorProps) => (
                    <a
                      {...props}
                      href={resolveReadmeLinkHref(raw, href)}
                      target="_blank"
                      rel="noopener noreferrer"
                    />
                  ),
                  img: ({ node: _node, src, ...props }: MarkdownImageProps) => {
                    const resolvedSrc = resolveReadmeImageSrc(raw, src)
                    if (!resolvedSrc) return null
                    return (
                      <img
                        {...props}
                        src={resolvedSrc}
                        loading="lazy"
                        onError={(e) => { e.currentTarget.style.display = "none" }}
                      />
                    )
                  },
                }}
              >
                {markdown}
              </ReactMarkdown>
              {canExpand && !expanded ? (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-20 items-end justify-center bg-gradient-to-b from-background/0 via-background/80 to-background pb-1.5">
                  <button
                    type="button"
                    onClick={handleExpand}
                    disabled={loadingDetail}
                    className="pointer-events-auto inline-flex items-center gap-1 rounded bg-muted/95 px-2.5 py-1 text-[11px] font-medium text-muted-foreground shadow-sm ring-1 ring-border/80 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    title="Expand README"
                  >
                    <Icon icon="solar:alt-arrow-down-bold" width={13} />
                    {loadingDetail ? "Loading..." : "Expand"}
                  </button>
                </div>
              ) : null}
            </div>
          </MarkdownErrorBoundary>
        </>
      )}

      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mt-2">
        <button
          type="button"
          className="hover:text-foreground hover:underline cursor-pointer"
          onClick={() => {
            navigator.clipboard.writeText(raw.fullName)
            toast.success(`Copied ${raw.fullName}`)
          }}
          title="Copy repository name"
        >
          {raw.readmePath || "README"}
        </button>
        <span style={{ opacity: 0.4 }}>&middot;</span>
        <span style={{ color: "#6e7681" }}>collected {formatDate(info.collectedAt)}</span>
      </div>
    </div>
  )
})
