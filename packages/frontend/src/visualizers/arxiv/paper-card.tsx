import React, { memo, useState, useCallback, useRef, useEffect, Suspense } from "react"
import { cn } from "@/lib/utils"
import type { ArxivItem } from "./types"
import { darkTheme } from "@uiw/react-json-view/dark"

const JsonView = React.lazy(() => import("@uiw/react-json-view"))
import { Icon } from "@iconify/react"
import { toast } from "sonner"

type ViewMode = "text" | "data"

interface PaperCardProps {
  item: ArxivItem
}

function formatDate(iso: string): string {
  if (!iso) return "\u2014"
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, "0")
    const day = String(d.getDate()).padStart(2, "0")
    return `${y}-${m}-${day}`
  } catch {
    return iso
  }
}

export const PaperCard = memo(function PaperCard({ item }: PaperCardProps) {
  const { rawData: raw, info } = item
  const [viewMode, setViewMode] = useState<ViewMode>("text")
  const [dlTriggered, setDlTriggered] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)

  // Reset triggered state when downloadPath becomes available
  useEffect(() => {
    if (info.downloadPath) setDlTriggered(false)
  }, [info.downloadPath])

  const handleCardKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
    const el = cardRef.current
    if (!el) return
    const parent = el.parentElement
    if (!parent) return
    const cards = parent.querySelectorAll(":scope > .arxiv-card")
    if (cards.length === 0) return
    const idx = Array.from(cards).indexOf(el)
    if (idx === -1) return
    const next = e.key === "ArrowDown" ? cards[idx + 1] : cards[idx - 1]
    if (next instanceof HTMLElement) {
      e.preventDefault()
      next.focus()
      next.scrollIntoView({ block: "nearest" })
    }
  }, [])

  const availableModes: ViewMode[] = ["text", "data"]

  return (
    <div
      ref={cardRef}
      tabIndex={0}
      onKeyDown={handleCardKeyDown}
      className="arxiv-card border border-border rounded-lg overflow-hidden hover:border-ring focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring relative outline-none"
      style={{ padding: "10px 12px", background: "#0d1117" }}
    >
      {/* View mode toggle group */}
      <div className="absolute top-1.5 right-1.5 z-10" onClick={(e) => e.stopPropagation()}>
        <div className="inline-flex bg-gray-700/80 rounded-md p-1">
          {availableModes.map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setViewMode(mode)}
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
      </div>

      {viewMode === "data" ? (
        <div
          style={{ borderRadius: 8, padding: "4px 0", marginTop: 20 }}
          className="max-h-[400px] overflow-y-auto overflow-x-hidden"
        >
          <Suspense fallback={<div className="text-xs text-muted-foreground p-2">Loading...</div>}>
            <JsonView
              value={item as unknown as object}
              style={{ ...darkTheme, wordBreak: "break-all", wordWrap: "break-word", whiteSpace: "pre-wrap" }}
              displayDataTypes={false}
              enableClipboard={true}
              shortenTextAfterLength={0}
            />
          </Suspense>
        </div>
      ) : (
        <>
          {/* Title */}
          <a
            href={raw.url}
            target="_blank"
            rel="noopener"
            className="text-sm font-semibold text-foreground hover:text-primary leading-snug block pr-20"
          >
            {raw.title}
          </a>

          {/* Authors */}
          <div className="text-xs text-muted-foreground mt-1 truncate">
            {raw.authors.map((author, i) => (
              <span key={i}>
                {i > 0 && ", "}
                <a
                  href={`https://arxiv.org/search/?query=${encodeURIComponent(author)}&searchtype=author`}
                  target="_blank"
                  rel="noopener"
                  className="hover:text-primary hover:underline"
                >
                  {author}
                </a>
              </span>
            ))}
          </div>

          {/* Abstract */}
          <CopyableText text={raw.abstract} className="text-xs text-foreground/80 mt-2 leading-relaxed" />

          {/* Versions */}
          {raw.versions && raw.versions.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground mt-2">
              {raw.versions.map((v) => (
                <span key={v.version}>
                  <span className="font-medium text-foreground/70">{v.version}</span>{" "}
                  {formatDate(v.date)}{" "}
                  <span style={{ opacity: 0.5 }}>({v.size})</span>
                </span>
              ))}
            </div>
          )}

          {/* Categories + PDF + Local */}
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            {raw.categories.map((cat) => (
              <span
                key={cat}
                className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium"
              >
                {cat}
              </span>
            ))}
            {raw.pdfUrl && (
              <a
                href={raw.pdfUrl}
                target="_blank"
                rel="noopener"
                className="text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary font-medium hover:bg-primary/25"
              >
                PDF
              </a>
            )}
            {info.downloadPath && (
              <button
                type="button"
                onClick={() => window.electronAPI?.showInFolder(info.downloadPath!)}
                className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/15 text-green-400 font-medium hover:bg-green-500/25"
              >
                Local
              </button>
            )}
            {!info.downloadPath && (
              dlTriggered ? (
                <a
                  href={`/jobs?job=arxiv_dl`}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/15 text-yellow-400 font-medium hover:bg-yellow-500/25"
                >
                  Downloading...
                </a>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setDlTriggered(true)
                    fetch("/api/v1/jobs/arxiv_dl/run", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ arxiv_id: raw.arxivId }),
                    })
                      .then((r) => {
                        if (r.ok) toast.success(`Download started: ${raw.arxivId}`)
                        else { toast.error("Failed to trigger download"); setDlTriggered(false) }
                      })
                      .catch(() => { toast.error("Failed to trigger download"); setDlTriggered(false) })
                  }}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary font-medium hover:bg-primary/25"
                >
                  Download
                </button>
              )
            )}
          </div>
        </>
      )}

      {/* Meta */}
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mt-1">
        <button
          type="button"
          className="hover:text-foreground hover:underline cursor-pointer"
          onClick={() => { navigator.clipboard.writeText(raw.arxivId); toast.success(`Copied ${raw.arxivId}`); }}
          title="Copy arxiv ID"
        >{raw.arxivId}</button>
        <span style={{ opacity: 0.4 }}>&middot;</span>
        <span style={{ color: "#6e7681" }}>collected {formatDate(info.collectedAt)}</span>
      </div>
    </div>
  )
})

function CopyableText({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <div className={cn("relative group", className)}>
      {text}
      <button
        type="button"
        onClick={() => {
          navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
        className="absolute top-0 right-0 p-1.5 rounded opacity-0 group-hover:opacity-100 transition-opacity bg-muted/80 hover:bg-muted text-muted-foreground hover:text-foreground"
      >
        {copied ? <Icon icon="solar:check-circle-bold" width={16} /> : <Icon icon="solar:copy-bold" width={16} />}
      </button>
    </div>
  )
}
