import React, { memo, useCallback, useEffect, useRef, useState, Suspense } from "react"
import { cn } from "@/lib/utils"
import type { XItem } from "./types"
import { formatTime } from "./helpers"
import { toast } from "sonner"
import { darkTheme } from "@uiw/react-json-view/dark"

const JsonView = React.lazy(() => import("@uiw/react-json-view"))

type ViewMode = "screenshot" | "text" | "data"

// Module-level cache for full item details (lazy-fetched when switching to text/data mode)
const detailCache = new Map<string, XItem>()

async function fetchDetail(itemId: string): Promise<XItem | null> {
  const cached = detailCache.get(itemId)
  if (cached) return cached
  try {
    const encodedId = encodeURIComponent(itemId)
    const resp = await fetch(`/api/v1/x/${encodedId}`)
    if (!resp.ok) return null
    const data = await resp.json() as { item?: XItem }
    if (data.item) {
      detailCache.set(itemId, data.item)
      return data.item
    }
  } catch { /* ignore */ }
  return null
}

interface ItemCardProps {
  item: XItem
  onTagFilter?: (tag: string) => void
  backlogTags?: Set<string>
  confirmedTags?: Set<string>
}

// ---------------------------------------------------------------------------
// Tag helpers
// ---------------------------------------------------------------------------

function tagColor(tag: string): string {
  let hash = 0
  for (let i = 0; i < tag.length; i++) hash = ((hash << 5) - hash + tag.charCodeAt(i)) | 0
  const hue = ((hash % 360) + 360) % 360
  return `hsl(${hue}, 55%, 45%)`
}

interface TagMenuState {
  x: number
  y: number
  tag: string
  isBacklog: boolean
}

// ---------------------------------------------------------------------------
// Image context menu helpers
// ---------------------------------------------------------------------------

interface ImgMenuState {
  x: number
  y: number
  src: string
}

async function srcToBlob(src: string): Promise<Blob> {
  if (src.startsWith("data:")) {
    // Decode data URI directly — fetch() on data: is blocked by CSP connect-src
    const [header, b64] = src.split(",")
    const mime = header?.match(/data:([^;]+)/)?.[1] ?? "image/png"
    const bin = atob(b64 ?? "")
    const arr = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
    return new Blob([arr], { type: mime })
  }
  const res = await fetch(src)
  return res.blob()
}

async function copyImage(src: string): Promise<void> {
  const blob = await srcToBlob(src)
  // Clipboard API requires image/png — convert if needed
  let pngBlob = blob
  if (blob.type !== "image/png") {
    const bmp = await createImageBitmap(blob)
    const canvas = new OffscreenCanvas(bmp.width, bmp.height)
    const ctx = canvas.getContext("2d")!
    ctx.drawImage(bmp, 0, 0)
    pngBlob = await canvas.convertToBlob({ type: "image/png" })
  }
  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": pngBlob }),
  ])
}

async function saveImage(src: string, filename: string): Promise<string | null> {
  const blob = await srcToBlob(src)
  // Use Electron's native save dialog when available
  if (window.electronAPI?.saveImageAs) {
    const buf = await blob.arrayBuffer()
    return window.electronAPI.saveImageAs(buf, filename)
  }
  // Fallback for browser: <a download>
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
  return null
}

// ---------------------------------------------------------------------------
// ItemCard
// ---------------------------------------------------------------------------

export const ItemCard = memo(function ItemCard({ item: t, onTagFilter, backlogTags, confirmedTags }: ItemCardProps) {
  const { info } = t
  const [screenshotSrc, setScreenshotSrc] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>(info.hasScreenshot ? "screenshot" : "text")
  const [fullItem, setFullItem] = useState<XItem | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const loadedRef = useRef(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const [imgMenu, setImgMenu] = useState<ImgMenuState | null>(null)
  const imgMenuRef = useRef<HTMLDivElement>(null)
  const [tagMenu, setTagMenu] = useState<TagMenuState | null>(null)
  const tagMenuRef = useRef<HTMLDivElement>(null)

  // Use full item if lazy-loaded, otherwise fall back to slim list item
  const displayItem = fullItem || t
  const raw = displayItem.rawData

  // Lazy-fetch full item detail when switching to text or data mode
  const handleViewModeChange = useCallback((mode: ViewMode) => {
    setViewMode(mode)
    if (mode !== "screenshot" && !fullItem && !loadingDetail) {
      setLoadingDetail(true)
      fetchDetail(info.id).then((item) => {
        if (item) setFullItem(item)
      }).finally(() => setLoadingDetail(false))
    }
  }, [info.id, fullItem, loadingDetail])

  // Lazy-load screenshot only when card enters viewport
  useEffect(() => {
    if (!info.hasScreenshot || loadedRef.current) return
    const el = cardRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !loadedRef.current) {
          loadedRef.current = true
          observer.disconnect()
          const encodedId = encodeURIComponent(info.id)
          fetch(`/api/v1/x/${encodedId}/screenshot`)
            .then((r) => r.json())
            .then((data) => {
              if (data?.screenshot) setScreenshotSrc(data.screenshot)
            })
            .catch(() => {})
        }
      },
      { rootMargin: "200px" },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [info.hasScreenshot, info.id])

  // Dismiss image context menu on any interaction outside the menu
  useEffect(() => {
    if (!imgMenu) return
    const dismissIfOutside = (e: Event) => {
      if (imgMenuRef.current?.contains(e.target as Node)) return
      setImgMenu(null)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setImgMenu(null) }
    document.addEventListener("mousedown", dismissIfOutside, true)
    document.addEventListener("contextmenu", dismissIfOutside, true)
    document.addEventListener("keydown", onKey, true)
    document.addEventListener("scroll", dismissIfOutside, true)
    return () => {
      document.removeEventListener("mousedown", dismissIfOutside, true)
      document.removeEventListener("contextmenu", dismissIfOutside, true)
      document.removeEventListener("keydown", onKey, true)
      document.removeEventListener("scroll", dismissIfOutside, true)
    }
  }, [imgMenu])

  // Dismiss tag context menu on outside interaction
  useEffect(() => {
    if (!tagMenu) return
    const dismissIfOutside = (e: Event) => {
      if (tagMenuRef.current?.contains(e.target as Node)) return
      setTagMenu(null)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setTagMenu(null) }
    document.addEventListener("mousedown", dismissIfOutside, true)
    document.addEventListener("keydown", onKey, true)
    document.addEventListener("scroll", dismissIfOutside, true)
    return () => {
      document.removeEventListener("mousedown", dismissIfOutside, true)
      document.removeEventListener("keydown", onKey, true)
      document.removeEventListener("scroll", dismissIfOutside, true)
    }
  }, [tagMenu])

  const handleTagClick = useCallback((e: React.MouseEvent, tag: string) => {
    e.preventDefault()
    e.stopPropagation()
    const rect = cardRef.current?.getBoundingClientRect()
    const isBacklog = confirmedTags ? !confirmedTags.has(tag) : (backlogTags?.has(tag) ?? false)
    setTagMenu({
      x: e.clientX - (rect?.left ?? 0),
      y: e.clientY - (rect?.top ?? 0),
      tag,
      isBacklog,
    })
  }, [backlogTags, confirmedTags])

  const handleCardKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
    const el = cardRef.current
    if (!el) return
    // Find the scrollable column ancestor, then all cards within it
    const column = el.closest(".group-scroll") ?? el.parentElement
    const cards = column?.querySelectorAll(".x-card")
    if (!cards || cards.length === 0) return
    const idx = Array.from(cards).indexOf(el)
    if (idx === -1) return
    const next = e.key === "ArrowDown" ? cards[idx + 1] : cards[idx - 1]
    if (next instanceof HTMLElement) {
      e.preventDefault()
      next.focus()
      next.scrollIntoView({ block: "nearest" })
    }
  }, [])

  const handleLinkClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
  }, [])

  const handleImgContextMenu = useCallback((e: React.MouseEvent, src: string) => {
    e.preventDefault()
    e.stopPropagation()
    const rect = cardRef.current?.getBoundingClientRect()
    setImgMenu({
      x: e.clientX - (rect?.left ?? 0),
      y: e.clientY - (rect?.top ?? 0),
      src,
    })
  }, [])

  // Build links array
  const allLinks: { url: string; text: string }[] = []
  if (raw.contentLinks && raw.contentLinks.length > 0) {
    for (const cl of raw.contentLinks) allLinks.push(cl)
  }
  if (raw.cardLink) {
    allLinks.push({
      url: raw.cardLink,
      text: raw.cardLink.replace(/^https?:\/\//, "").slice(0, 40),
    })
  }
  if (raw.quotedTweetUrl) {
    allLinks.push({
      url: raw.quotedTweetUrl,
      text: raw.quotedTweetUrl.replace(/^https?:\/\//, ""),
    })
  }

  const imageUrls = Array.isArray(raw.imageUrls) ? raw.imageUrls : []
  const hasContent = raw.text || imageUrls.length > 0 || allLinks.length > 0

  const availableModes: ViewMode[] = info.hasScreenshot
    ? ["screenshot", "text", "data"]
    : ["text", "data"]

  return (
    <div
      ref={cardRef}
      tabIndex={0}
      onKeyDown={handleCardKeyDown}
      className="x-card border border-border rounded-lg overflow-hidden hover:border-ring focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring relative outline-none"
      style={{ padding: "6px 8px" }}
    >
      {/* View mode toggle group */}
      <div className="absolute top-1.5 right-1.5 z-10" onClick={(e) => e.stopPropagation()}>
        <div className="inline-flex bg-gray-700/80 rounded-md p-1">
          {availableModes.map((mode) => (
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
        {/* Article badge */}
        {raw.articleHtml && (
          <div className="flex justify-end mt-1">
            <button
              type="button"
              className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-colors leading-tight"
              onClick={() => { window.location.href = "/reader?id=" + encodeURIComponent(info.id) }}
            >
              Article
            </button>
          </div>
        )}
      </div>

      {/* Content area based on view mode */}
      {viewMode === "screenshot" && info.hasScreenshot ? (
        screenshotSrc ? (
          <img
            className="w-full cursor-pointer"
            style={{ borderRadius: 8, marginBottom: 4 }}
            src={screenshotSrc}
            alt={raw.text || ""}
            title={raw.text || ""}
            loading="lazy"
            onClick={() => window.open(raw.url, "_blank")}
            onContextMenu={(e) => handleImgContextMenu(e, screenshotSrc)}
          />
        ) : (
          <div className="flex items-center justify-center h-24 text-xs text-muted-foreground">
            Loading...
          </div>
        )
      ) : viewMode === "data" ? (
        <div
          style={{ background: "#0d1117", borderRadius: 8, padding: "8px 10px", marginTop: 20 }}
          className="max-h-[400px] overflow-y-auto overflow-x-hidden"
        >
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
      ) : loadingDetail && !fullItem ? (
        <div className="flex items-center justify-center h-24 text-xs text-muted-foreground animate-pulse">
          Loading...
        </div>
      ) : (
        /* text mode (also fallback) */
        <div
          className="cursor-pointer"
          style={{ background: "#0d1117", borderRadius: 8, padding: "8px 10px" }}
          onClick={() => window.open(raw.url, "_blank")}
        >
          {/* Profile header */}
          {(raw.avatarUrl || raw.displayName || raw.handle) && (
            <div className="flex items-center gap-2 mb-2">
              {raw.avatarUrl && (
                <img
                  src={raw.avatarUrl}
                  className="w-8 h-8 rounded-full shrink-0"
                  onError={(e) => {
                    ;(e.target as HTMLImageElement).style.display = "none"
                  }}
                  alt=""
                />
              )}
              <div className="flex flex-col leading-tight min-w-0">
                {raw.displayName && (
                  <span className="font-semibold text-foreground truncate" style={{ fontSize: 13 }}>
                    {raw.displayName}
                  </span>
                )}
                {raw.handle && (
                  <span className="text-xs text-muted-foreground truncate">
                    {raw.handle}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Post text */}
          {raw.text && (
            <div className="text-foreground whitespace-pre-wrap break-words" style={{ fontSize: 13, lineHeight: 1.45, marginBottom: 6 }}>
              {raw.text}
            </div>
          )}

          {/* Image thumbnails */}
          {imageUrls.length > 0 && (
            <div
              className={cn(
                "mt-1.5",
                imageUrls.length > 1 &&
                  "grid gap-1",
              )}
              style={
                imageUrls.length > 1
                  ? {
                      gridTemplateColumns: `repeat(${Math.min(imageUrls.length, 4)}, 1fr)`,
                    }
                  : undefined
              }
            >
              {imageUrls.slice(0, 4).map((imgUrl, i) => (
                <img
                  key={i}
                  src={imgUrl}
                  className={cn(
                    "rounded",
                    imageUrls.length > 1
                      ? "w-full h-[120px] object-cover"
                      : "w-full rounded",
                  )}
                  loading="lazy"
                  onError={(e) => {
                    ;(e.target as HTMLImageElement).style.display = "none"
                  }}
                  onContextMenu={(e) => handleImgContextMenu(e, imgUrl)}
                  alt=""
                />
              ))}
            </div>
          )}

          {/* Links */}
          {allLinks.length > 0 && (
            <div className="mt-1.5 flex flex-col gap-0.5">
              {allLinks.map((link, i) => (
                <a
                  key={i}
                  href={link.url}
                  target="_blank"
                  rel="noopener"
                  onClick={handleLinkClick}
                  className="text-xs text-primary hover:underline truncate block"
                >
                  {link.text || link.url}
                </a>
              ))}
            </div>
          )}

          {/* Article preview */}
          {raw.articleHtml && (() => {
            const tmp = document.createElement("div")
            tmp.innerHTML = raw.articleHtml
            const plain = (tmp.textContent || tmp.innerText || "").trim()
            const truncated = plain.length > 512 ? plain.slice(0, 512) + "..." : plain
            return (
              <div className="mt-2 pt-2 border-t border-white/10">
                <span className="text-[10px] font-semibold text-blue-400 uppercase tracking-wide">Article:</span>
                <div className="text-muted-foreground whitespace-pre-wrap break-words mt-0.5" style={{ fontSize: 12, lineHeight: 1.4 }}>
                  {truncated}
                </div>
              </div>
            )
          })()}

          {/* Fallback for no content */}
          {!hasContent && (
            <div className="text-xs text-muted-foreground italic mt-1">
              [media content]
            </div>
          )}
        </div>
      )}

      {/* Tags */}
      {info.tags && info.tags.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap mt-1">
          {info.tags.map((tag) => {
            const isBacklog = confirmedTags ? !confirmedTags.has(tag) : (backlogTags?.has(tag) ?? false)
            const color = tagColor(tag)
            return (
              <span
                key={tag}
                className={cn(
                  "text-[10px] font-semibold px-1.5 py-0.5 rounded-full cursor-pointer select-none leading-tight",
                  !isBacklog && "text-white",
                )}
                style={
                  isBacklog
                    ? { border: `1px dashed ${color}`, color, background: `${color}15` }
                    : { background: color }
                }
                onClick={(e) => handleTagClick(e, tag)}
              >
                {tag}
              </span>
            )
          })}
        </div>
      )}

      {/* Meta */}
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mt-1">
        <span>tweet {formatTime(raw.tweetAt)}</span>
        <span style={{ opacity: 0.4 }}>&middot;</span>
        <span style={{ color: "#6e7681" }}>
          collect {info.collectedAt ? formatTime(info.collectedAt) : "\u2014"}
        </span>
      </div>

      {/* Tag context menu */}
      {tagMenu && (
        <div
          ref={tagMenuRef}
          className="fixed z-[9999] rounded-lg shadow-2xl py-1.5 min-w-[140px] text-[13px]"
          style={{
            left: tagMenu.x + (cardRef.current?.getBoundingClientRect().left ?? 0),
            top: tagMenu.y + (cardRef.current?.getBoundingClientRect().top ?? 0),
            background: "rgba(40, 40, 40, 0.95)",
            backdropFilter: "blur(20px)",
            border: "0.5px solid rgba(255, 255, 255, 0.15)",
            color: "#e8e8e8",
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="w-full text-left px-3.5 py-1 hover:bg-[#2563eb] hover:text-white rounded-[3px] mx-0.5 transition-none"
            style={{ width: "calc(100% - 4px)" }}
            onClick={() => {
              setTagMenu(null)
              navigator.clipboard.writeText(tagMenu.tag)
                .then(() => toast.success("Tag copied"))
                .catch(() => toast.error("Failed to copy tag"))
            }}
          >
            Copy
          </button>
          <button
            type="button"
            className="w-full text-left px-3.5 py-1 hover:bg-[#2563eb] hover:text-white rounded-[3px] mx-0.5 transition-none"
            style={{ width: "calc(100% - 4px)" }}
            onClick={() => {
              const filterTag = tagMenu.tag
              setTagMenu(null)
              if (onTagFilter) {
                onTagFilter(filterTag)
              }
            }}
          >
            Filter
          </button>
          {tagMenu.isBacklog && (
            <button
              type="button"
              className="w-full text-left px-3.5 py-1 hover:bg-[#2563eb] hover:text-white rounded-[3px] mx-0.5 transition-none"
              style={{ width: "calc(100% - 4px)" }}
              onClick={() => {
                const promotedTag = tagMenu.tag
                setTagMenu(null)
                fetch("/api/v1/x/tags/promote", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ tag: promotedTag }),
                })
                  .then((r) => {
                    if (r.ok) toast.success(`Promoted "${promotedTag}"`)
                    else toast.error("Failed to promote tag")
                  })
                  .catch(() => toast.error("Failed to promote tag"))
              }}
            >
              Promote Backlog Tag
            </button>
          )}
        </div>
      )}

      {/* Image context menu — Chrome native style */}
      {imgMenu && (
        <div
          ref={imgMenuRef}
          className="fixed z-[9999] rounded-lg shadow-2xl py-1.5 min-w-[180px] text-[13px]"
          style={{
            left: imgMenu.x + (cardRef.current?.getBoundingClientRect().left ?? 0),
            top: imgMenu.y + (cardRef.current?.getBoundingClientRect().top ?? 0),
            background: "rgba(40, 40, 40, 0.95)",
            backdropFilter: "blur(20px)",
            border: "0.5px solid rgba(255, 255, 255, 0.15)",
            color: "#e8e8e8",
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="w-full text-left px-3.5 py-1 hover:bg-[#2563eb] hover:text-white rounded-[3px] mx-0.5 transition-none"
            style={{ width: "calc(100% - 4px)" }}
            onClick={() => {
              const src = imgMenu.src
              setImgMenu(null)
              copyImage(src)
                .then(() => toast.success("Image copied to clipboard"))
                .catch(() => toast.error("Failed to copy image"))
            }}
          >
            Copy Image
          </button>
          <button
            type="button"
            className="w-full text-left px-3.5 py-1 hover:bg-[#2563eb] hover:text-white rounded-[3px] mx-0.5 transition-none"
            style={{ width: "calc(100% - 4px)" }}
            onClick={() => {
              const src = imgMenu.src
              const name = `tweet-${raw.tweetId || "image"}.png`
              setImgMenu(null)
              saveImage(src, name)
                .then((savedPath) => {
                  if (!savedPath) return
                  const fileName = savedPath.split("/").pop() ?? savedPath
                  toast.success(
                    <span className="text-xs">
                      Saved to{" "}
                      <button
                        type="button"
                        className="underline text-primary hover:text-primary/80 px-1 py-0.5 -mx-1 -my-0.5 rounded hover:bg-primary/10 transition-colors"
                        onClick={() => window.electronAPI?.showInFolder(savedPath)}
                      >
                        {fileName}
                      </button>
                    </span>,
                  )
                })
                .catch(() => toast.error("Failed to save image"))
            }}
          >
            Save Image As...
          </button>
        </div>
      )}
    </div>
  )
})
