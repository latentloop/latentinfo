/**
 * web_clip_markdown job — processes clipped HTML into markdown, downloads images,
 * and writes everything to the filesystem.
 *
 * Triggered by web_clip:collected event or manual run with params: { clipId: "..." } or
 * { docId: "..." } for backward compat with old x_article manual runs.
 *
 * Reads raw HTML from SQLite (stored by the web_clipper collector), converts
 * to markdown via Defuddle, downloads referenced images, writes .md + media
 * files to disk, and updates the SQLite row with the markdown_path.
 */

import { createHash } from "node:crypto"
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { JobDefinition, JobContext } from "../types.js"
import { insertArticle, getArticle, updateArticle, type ArticleRow } from "../../storage/article-db.js"
import { getProfileDir } from "../../config.js"

const DEBOUNCE_MS = 5000
const DOWNLOAD_TIMEOUT_MS = 30_000
const VIDEO_DOWNLOAD_TIMEOUT_MS = 120_000
const BATCH_SIZE = 10

// ---------------------------------------------------------------------------
// Job config
// ---------------------------------------------------------------------------

interface JobConfig {
  download_dir?: string
  download_video?: boolean
  video_quality?: string
  event_enabled?: boolean
}

function loadJobConfig(jobDir: string): JobConfig {
  const configPath = join(jobDir, "config.json")
  if (!existsSync(configPath)) return {}
  try {
    return JSON.parse(readFileSync(configPath, "utf-8")) as JobConfig
  } catch {
    return {}
  }
}

function getDownloadDir(config: JobConfig): string {
  return config.download_dir ?? join(getProfileDir(), "downloads", "web_clips")
}

/** Sanitize a title for filesystem use. */
function slugify(title: string, fallbackId: string): string {
  let slug = title
    .replace(/[/\\:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  if (!slug) slug = fallbackId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40)
  return slug
}

/** Get yyyy-mm-dd date folder from local datetime. */
function getDateFolder(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

// ---------------------------------------------------------------------------
// Embed image links into markdown
// ---------------------------------------------------------------------------

/**
 * Strip query params and fragment from a URL, returning just scheme+host+path.
 * Falls back to the original string if URL parsing fails.
 */
function urlPathOnly(raw: string): string {
  try {
    const u = new URL(raw)
    return `${u.origin}${u.pathname}`
  } catch {
    // Not a full URL — return as-is (could be a relative path)
    return raw.split("?")[0]!.split("#")[0]!
  }
}

/**
 * Escape a string for use inside a RegExp.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Post-process markdown to embed image references for all downloaded images.
 *
 * For each downloaded image:
 *   1. If its URL (path-matched, ignoring query params) appears in the markdown,
 *      replace the URL with a relative path to the attachment.
 *   2. Otherwise, append a new `![image](relative_path)` at the end.
 */
function embedImageLinks(
  markdown: string,
  downloadedImages: DownloadedImage[],
  mdFilename: string,
): string {
  if (downloadedImages.length === 0) return markdown

  let result = markdown
  const attachPrefix = `${mdFilename}_Attachments`

  for (const img of downloadedImages) {
    const imgPath = urlPathOnly(img.url)
    // Match the URL path (ignoring trailing slash) followed by optional query/fragment,
    // up to the closing paren or whitespace of a markdown image link.
    const pattern = new RegExp(escapeRegExp(imgPath.replace(/\/$/, "")) + `[^)\\s]*`, "g")
    // URL-encode the relative path so CommonMark parsers handle spaces in filenames
    const relativePath = encodeURI(`${attachPrefix}/${img.filename}`)
    // Replace URL if present, or append at end if not found
    let found = false
    result = result.replace(pattern, () => { found = true; return relativePath })
    if (!found) {
      result += `\n\n![image](${relativePath})`
    }
  }

  return result
}

/**
 * Write markdown + media to filesystem.
 * Returns the markdown_path (relative to output_dir), media_data array,
 * and the modified markdown (with embedded image links).
 */
function writeToFilesystem(
  outputDir: string,
  title: string,
  clipId: string,
  markdown: string,
  downloadedImages: DownloadedImage[],
  downloadedVideo: DownloadedMedia | null,
  log: JobContext["log"],
): { markdownPath: string; mediaData: string[]; markdown: string } {
  const dateFolder = getDateFolder()
  const slug = slugify(title, clipId)
  const dirPath = join(outputDir, dateFolder)
  mkdirSync(dirPath, { recursive: true })

  // Handle collision: if file exists, append short hash
  let mdFilename = `${slug}.md`
  let finalSlug = slug
  if (existsSync(join(dirPath, mdFilename))) {
    const hash = createHash("sha256").update(clipId).digest("hex").slice(0, 6)
    finalSlug = `${slug}-${hash}`
    mdFilename = `${finalSlug}.md`
  }

  // Embed image links into markdown before writing
  const modifiedMarkdown = embedImageLinks(markdown, downloadedImages, mdFilename)

  // Write markdown file
  const mdPath = join(dirPath, mdFilename)
  writeFileSync(mdPath, modifiedMarkdown, "utf-8")
  log.info(`Wrote markdown to ${mdPath}`)

  // Write media files
  const mediaData: string[] = []
  const hasMedia = downloadedImages.length > 0 || downloadedVideo !== null

  if (hasMedia) {
    const attachDir = join(dirPath, `${mdFilename}_Attachments`)
    mkdirSync(attachDir, { recursive: true })

    for (const img of downloadedImages) {
      writeFileSync(join(attachDir, img.filename), img.data)
      mediaData.push(JSON.stringify({ type: "image", url: img.url, contentType: img.contentType, filename: img.filename }))
    }

    if (downloadedVideo) {
      writeFileSync(join(attachDir, downloadedVideo.filename), downloadedVideo.data)
      mediaData.push(JSON.stringify({
        type: "video",
        url: downloadedVideo.url,
        contentType: downloadedVideo.contentType,
        filename: downloadedVideo.filename,
        bitrate: downloadedVideo.bitrate,
        resolution: downloadedVideo.resolution,
      }))
    }

    log.info(`Wrote ${mediaData.length} media files to ${attachDir}`)
  }

  const markdownPath = `${dateFolder}/${mdFilename}`
  return { markdownPath, mediaData, markdown: modifiedMarkdown }
}

// ---------------------------------------------------------------------------
// HTML → markdown conversion via Defuddle
// ---------------------------------------------------------------------------

async function convertToMarkdown(html: string, sourceUrl?: string): Promise<{ markdown: string; cleanedHtml: string }> {
  try {
    const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><article>${html}</article></body></html>`
    const { Defuddle } = await import("defuddle/node")
    const result = await Defuddle(fullHtml, sourceUrl ?? "https://example.com", { separateMarkdown: true })
    const markdown = result.contentMarkdown ?? result.content?.replace(/<[^>]+>/g, "").trim() ?? ""
    const cleanedHtml = result.content ?? html
    return { markdown, cleanedHtml }
  } catch (e: unknown) {
    console.warn(`Defuddle conversion failed, using basic fallback: ${e instanceof Error ? e.message : e}`)
    const fallbackMd = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<h([1-6])[^>]*>/gi, (_m: string, level: string) => "#".repeat(parseInt(level)) + " ")
      .replace(/<\/h[1-6]>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
    return { markdown: fallbackMd, cleanedHtml: html }
  }
}

// ---------------------------------------------------------------------------
// Image download
// ---------------------------------------------------------------------------

interface DownloadedImage {
  url: string
  contentType: string
  filename: string
  data: Buffer
}

function extensionFromContentType(ct: string): string {
  if (ct.includes("png")) return ".png"
  if (ct.includes("jpeg") || ct.includes("jpg")) return ".jpg"
  if (ct.includes("gif")) return ".gif"
  if (ct.includes("webp")) return ".webp"
  if (ct.includes("svg")) return ".svg"
  return ".bin"
}

async function downloadImage(
  url: string,
  index: number,
  log: JobContext["log"],
): Promise<DownloadedImage | null> {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      headers: { "User-Agent": "latent-info/1.0" },
    })
    if (!resp.ok) {
      log.warn(`HTTP ${resp.status} downloading image: ${url}`)
      return null
    }

    const buf = Buffer.from(await resp.arrayBuffer())
    if (buf.length === 0) {
      log.warn(`Empty response downloading image: ${url}`)
      return null
    }

    const contentType = resp.headers.get("content-type") ?? "application/octet-stream"
    const ext = extensionFromContentType(contentType)
    const filename = `img_${index}${ext}`

    log.info(`Downloaded image ${filename} (${(buf.length / 1024).toFixed(0)} KB)`)
    return { url, contentType, filename, data: buf }
  } catch (e: unknown) {
    log.warn(`Image download failed ${url}: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// Extract image URLs from HTML
// ---------------------------------------------------------------------------

function extractImageUrls(html: string): string[] {
  const urls: string[] = []
  const seen = new Set<string>()
  // Match <img> src attributes
  const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi
  let match: RegExpExecArray | null
  while ((match = imgRegex.exec(html)) !== null) {
    const src = match[1]!
    if (src && !seen.has(src) && src.startsWith("http")) {
      seen.add(src)
      urls.push(src)
    }
  }
  return urls
}

function collectClipImageUrls(html: string, rawCollectData: string, log?: Pick<JobContext["log"], "warn">): string[] {
  const htmlUrls = extractImageUrls(html)
  const seen = new Set<string>()
  const urls: string[] = []

  // Collect_data.imageUrls is the authoritative order (e.g. hero image first for X articles).
  // Process it first so its ordering is preserved.
  try {
    const collectData = JSON.parse(rawCollectData) as { imageUrls?: unknown }
    if (Array.isArray(collectData.imageUrls) && collectData.imageUrls.length > 0) {
      for (const candidate of collectData.imageUrls) {
        if (typeof candidate !== "string" || !candidate.startsWith("http") || seen.has(candidate)) continue
        seen.add(candidate)
        urls.push(candidate)
      }
    }
  } catch {
    log?.warn("Malformed collect_data while collecting image URLs; using HTML-derived URLs only")
  }

  // Append any HTML images not already covered by collect_data
  for (const url of htmlUrls) {
    if (seen.has(url)) continue
    seen.add(url)
    urls.push(url)
  }

  // If collect_data had no imageUrls, fall back to HTML-only
  return urls.length > 0 ? urls : htmlUrls
}

// ---------------------------------------------------------------------------
// Video download via syndication API (X-specific, best-effort)
// ---------------------------------------------------------------------------

interface SyndicationVideoVariant {
  bitrate?: number
  content_type: string
  url: string
}

interface SyndicationMediaDetail {
  type?: string
  video_info?: {
    variants: SyndicationVideoVariant[]
    aspect_ratio?: number[]
  }
}

interface SyndicationResponse {
  mediaDetails?: SyndicationMediaDetail[]
}

interface DownloadedMedia {
  url: string
  contentType: string
  filename: string
  data: Buffer
  type: "video"
  bitrate?: number
  resolution?: string
}

function selectVariant(
  variants: SyndicationVideoVariant[],
  quality: string,
): SyndicationVideoVariant | undefined {
  if (variants.length === 0) return undefined
  const sorted = [...variants].sort((a, b) => (a.bitrate ?? 0) - (b.bitrate ?? 0))
  switch (quality) {
    case "360p": {
      const target = 832_000
      return sorted.reduce((best, v) =>
        Math.abs((v.bitrate ?? 0) - target) < Math.abs((best.bitrate ?? 0) - target) ? v : best,
      )
    }
    case "720p": {
      const target = 2_176_000
      return sorted.reduce((best, v) =>
        Math.abs((v.bitrate ?? 0) - target) < Math.abs((best.bitrate ?? 0) - target) ? v : best,
      )
    }
    case "1080p":
      return sorted[sorted.length - 1]
    case "lowest":
    default:
      return sorted[0]
  }
}

function stripQueryParams(url: string): string {
  const idx = url.indexOf("?")
  return idx === -1 ? url : url.slice(0, idx)
}

function guessResolution(bitrate: number): string {
  if (bitrate <= 300_000) return "240x136"
  if (bitrate <= 900_000) return "480x270"
  if (bitrate <= 2_500_000) return "720x404"
  return "1280x720"
}

async function downloadVideo(
  tweetId: string,
  quality: string,
  log: JobContext["log"],
): Promise<DownloadedMedia | null> {
  const token = Math.floor(Math.random() * 9_999_999_999)
  const apiUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=${token}`

  log.info(`Fetching syndication API for tweet ${tweetId}`)
  const resp = await fetch(apiUrl, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    headers: { "User-Agent": "latent-info/1.0" },
  })

  if (!resp.ok) {
    log.warn(`Syndication API returned HTTP ${resp.status} for tweet ${tweetId}`)
    return null
  }

  let data: SyndicationResponse
  try {
    data = (await resp.json()) as SyndicationResponse
  } catch {
    log.warn(`Failed to parse syndication response for tweet ${tweetId}`)
    return null
  }
  if (!data.mediaDetails || data.mediaDetails.length === 0) {
    log.info(`No media details in syndication response for tweet ${tweetId}`)
    return null
  }

  const videoMedia = data.mediaDetails.find(
    (m) => m.video_info && m.video_info.variants && m.video_info.variants.length > 0,
  )
  if (!videoMedia || !videoMedia.video_info) {
    log.info(`No video found in syndication response for tweet ${tweetId}`)
    return null
  }

  const mp4Variants = videoMedia.video_info.variants.filter(
    (v) => v.content_type === "video/mp4",
  )
  if (mp4Variants.length === 0) {
    log.info(`No MP4 variants found for tweet ${tweetId}`)
    return null
  }

  const chosen = selectVariant(mp4Variants, quality)
  if (!chosen) {
    log.warn(`Could not select a video variant for tweet ${tweetId}`)
    return null
  }

  const cleanUrl = stripQueryParams(chosen.url)
  log.info(`Downloading video for tweet ${tweetId} (bitrate: ${chosen.bitrate ?? "unknown"}) from ${cleanUrl}`)

  const videoResp = await fetch(cleanUrl, {
    signal: AbortSignal.timeout(VIDEO_DOWNLOAD_TIMEOUT_MS),
    headers: { "User-Agent": "latent-info/1.0" },
  })

  if (!videoResp.ok) {
    log.warn(`HTTP ${videoResp.status} downloading video: ${cleanUrl}`)
    return null
  }

  const buf = Buffer.from(await videoResp.arrayBuffer())
  if (buf.length === 0) {
    log.warn(`Empty response downloading video: ${cleanUrl}`)
    return null
  }

  const bitrate = chosen.bitrate ?? 0
  const resolution = guessResolution(bitrate)

  log.info(`Downloaded video_0.mp4 (${(buf.length / 1024).toFixed(0)} KB, bitrate: ${bitrate}, resolution: ${resolution})`)

  return {
    url: chosen.url,
    contentType: "video/mp4",
    filename: "video_0.mp4",
    data: buf,
    type: "video",
    bitrate,
    resolution,
  }
}

// ---------------------------------------------------------------------------
// Job definition
// ---------------------------------------------------------------------------

const webClipMarkdownJob: JobDefinition = {
  id: "web_clip_markdown",
  description: "Process web clips into markdown with images",

  register(ctx) {
    ctx.on("web_clip:collected", () => {
      // no-op: the job runner calls run() for jobs that have it
    })
  },

  async run(ctx) {
    // Concurrency is managed by the job-runner's drain queue — no per-job guard needed.
    return await runInner(ctx)
  },
}

async function runInner(ctx: JobContext): Promise<Record<string, unknown>> {
  // Dedup is handled by the job-runner's drain queue (Set-based).
  // No per-job debounce needed — each clipId is processed exactly once.

  // Determine what to process
  const clipId = (ctx.params?.clipId as string | undefined) ?? (ctx.params?.docId as string | undefined)
  const clipIds = ctx.params?.clipIds as string[] | undefined
  const docIds = ctx.params?.docIds as string[] | undefined

  if (clipId) {
    const result = await processClip(clipId, ctx)
    await ctx.recordRun(result)
    if (!result.error) ctx.invalidateCache()
    return result
  }

  const ids = clipIds ?? docIds
  if (Array.isArray(ids) && ids.length > 0) {
    ctx.log.info(`Processing ${ids.length} targeted clips`)
    const processedIds: string[] = []
    const failedIds: string[] = []
    for (const id of ids) {
      try {
        const result = await processClip(id, ctx)
        if (result.error) failedIds.push(id)
        else processedIds.push(id)
      } catch (e: unknown) {
        ctx.log.error(`Failed to process ${id}: ${e instanceof Error ? e.message : e}`)
        failedIds.push(id)
      }
    }
    const aggregated = { processed: processedIds, failed: failedIds, total: ids.length }
    await ctx.recordRun(aggregated)
    if (processedIds.length > 0) ctx.invalidateCache()
    return aggregated
  }

  // Reprocess all articles (manual trigger with reprocessAll param or no specific IDs)
  if (ctx.trigger === "manual" && (ctx.params?.reprocessAll || (!clipId && !ids))) {
    ctx.log.info("Reprocessing all articles with improved markdown conversion")
    const allRows = await ctx.db.execute({
      sql: "SELECT id FROM articles WHERE content IS NOT NULL AND content != ''",
      args: [],
    })
    const allIds = allRows.rows.map((r) => r.id as string)
    if (allIds.length === 0) {
      const empty = { processed: [] as string[], failed: [] as string[], total: 0 }
      await ctx.recordRun(empty)
      return empty
    }
    ctx.log.info(`Found ${allIds.length} articles to reprocess`)
    const processedIds: string[] = []
    const failedIds: string[] = []
    for (const id of allIds) {
      try {
        const result = await processClip(id, ctx)
        if (result.error) failedIds.push(id)
        else processedIds.push(id)
      } catch (e: unknown) {
        ctx.log.error(`Failed to reprocess ${id}: ${e instanceof Error ? e.message : e}`)
        failedIds.push(id)
      }
    }
    const aggregated = { processed: processedIds, failed: failedIds, total: allIds.length }
    await ctx.recordRun(aggregated)
    if (processedIds.length > 0) ctx.invalidateCache()
    return aggregated
  }

  const batchResult = { processed: [] as string[], failed: [] as string[], total: 0 }
  return batchResult
}

// ---------------------------------------------------------------------------
// Process a clip from SQLite (new path — web_clipper collector stored it)
// ---------------------------------------------------------------------------

async function processClip(
  clipId: string,
  ctx: JobContext,
): Promise<Record<string, unknown>> {
  // If this is a legacy X doc ID (starts with "x:"), use the legacy path
  if (clipId.startsWith("x:")) {
    return processLegacyXArticle(clipId, ctx)
  }

  // Read clip from SQLite
  const article = await getArticle(clipId)
  if (!article) {
    ctx.log.error(`Clip not found: ${clipId}`)
    return { error: `Clip not found: ${clipId}` }
  }

  const html = article.content
  if (!html) {
    ctx.log.info(`No content in clip ${clipId}, skipping`)
    return { skipped: true, clipId, reason: "no content" }
  }

  try {
    // Parse collect_data for source URL
    let sourceUrl = "https://example.com"
    try {
      const cd = JSON.parse(article.collect_data) as { url?: string }
      if (cd.url) sourceUrl = cd.url
    } catch { ctx.log.warn(`Malformed collect_data in clip ${clipId}`) }

    // Convert HTML to markdown
    const { markdown, cleanedHtml } = await convertToMarkdown(html, sourceUrl)
    ctx.log.info(`Converted clip ${clipId} to markdown (${markdown.length} chars)`)

    // Extract and download images from HTML and collector-supplied metadata
    const htmlImageCount = extractImageUrls(html).length
    const imageUrls = collectClipImageUrls(html, article.collect_data, ctx.log)
    const metadataImageCount = Math.max(0, imageUrls.length - htmlImageCount)
    ctx.log.info(`Resolved ${imageUrls.length} image URLs for ${clipId} (${htmlImageCount} from HTML, ${metadataImageCount} from collect_data)`)
    const downloadedImages: DownloadedImage[] = []
    for (let i = 0; i < imageUrls.length; i++) {
      const img = await downloadImage(imageUrls[i]!, i, ctx.log)
      if (img) downloadedImages.push(img)
    }
    ctx.log.info(`Downloaded ${downloadedImages.length}/${imageUrls.length} images for ${clipId}`)

    // Video download: X-specific, only if source URL is x.com
    const config = loadJobConfig(ctx.jobDir)
    let downloadedVideo: DownloadedMedia | null = null

    if (config.download_video !== false && sourceUrl.includes("x.com/") && sourceUrl.includes("/status/")) {
      try {
        const tweetIdMatch = sourceUrl.match(/\/status\/(\d+)/)
        if (tweetIdMatch) {
          downloadedVideo = await downloadVideo(tweetIdMatch[1]!, config.video_quality ?? "lowest", ctx.log)
        }
      } catch (e: unknown) {
        ctx.log.warn(`Video download failed for ${clipId}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // Parse title for filesystem slug
    let articleTitle = ""
    try {
      const cd = JSON.parse(article.collect_data) as { title?: string }
      articleTitle = cd.title ?? ""
    } catch { /* use empty */ }

    // Write markdown + media to filesystem
    const outputDir = getDownloadDir(config)
    const { markdownPath, mediaData, markdown: linkedMarkdown } = writeToFilesystem(
      outputDir, articleTitle, clipId, markdown,
      downloadedImages, downloadedVideo, ctx.log,
    )

    // Update the existing clip row with markdown + media (no new version).
    // The clip row was created by storeClip(); the markdown job enriches it in-place.
    await updateArticle(clipId, {
      content: cleanedHtml,
      markdown: linkedMarkdown,
      media_data: mediaData,
      markdown_path: markdownPath,
    })
    ctx.log.info(`Updated clip ${clipId} with markdown + media`)

    return {
      clipId,
      markdownLength: linkedMarkdown.length,
      imagesDownloaded: downloadedImages.length,
      imagesTotal: imageUrls.length,
      videoDownloaded: downloadedVideo !== null,
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    ctx.log.error(`Failed to process clip ${clipId}: ${msg}`)
    return { error: msg, clipId }
  }
}

// ---------------------------------------------------------------------------
// Legacy: process X article from SQLite document (backward compat)
// ---------------------------------------------------------------------------

async function processLegacyXArticle(
  docId: string,
  ctx: JobContext,
): Promise<Record<string, unknown>> {
  const docResult = await ctx.db.execute({
    sql: "SELECT doc FROM documents WHERE id = ?",
    args: [docId],
  })

  if (docResult.rows.length === 0) {
    ctx.log.error(`Document not found: ${docId}`)
    return { error: `Document not found: ${docId}` }
  }

  const doc = typeof docResult.rows[0]!.doc === "string"
    ? JSON.parse(docResult.rows[0]!.doc as string) as Record<string, unknown>
    : docResult.rows[0]!.doc as unknown as Record<string, unknown>

  const info = (doc.info as Record<string, unknown>) ?? {}
  const articleHtml = (doc.articleHtml as string | undefined) || (info.articleHtml as string | undefined)
  const articleImageUrls = (doc.articleImageUrls as string[]) ?? (info.articleImageUrls as string[]) ?? []
  const articleTitle = (doc.articleTitle as string) ?? (info.articleTitle as string) ?? ""
  const runCount = (typeof info.x_article_job_run === "number" ? info.x_article_job_run : 0) + 1

  if (!articleHtml) {
    ctx.log.info(`No articleHtml in ${docId}, skipping`)
    return { skipped: true, docId, reason: "no articleHtml" }
  }

  try {
    const { markdown, cleanedHtml } = await convertToMarkdown(articleHtml, "https://x.com/article")
    ctx.log.info(`Converted article ${docId} to markdown (${markdown.length} chars)`)

    const downloadedImages: DownloadedImage[] = []
    for (let i = 0; i < articleImageUrls.length; i++) {
      const img = await downloadImage(articleImageUrls[i]!, i, ctx.log)
      if (img) downloadedImages.push(img)
    }
    ctx.log.info(`Downloaded ${downloadedImages.length}/${articleImageUrls.length} images for ${docId}`)

    // Video download
    const config = loadJobConfig(ctx.jobDir)
    const shouldDownloadVideo = config.download_video !== false
    const videoQuality = config.video_quality ?? "lowest"
    let downloadedVideo: DownloadedMedia | null = null

    if (shouldDownloadVideo && docId.startsWith("x:")) {
      try {
        const tweetId = docId.slice(2)

        // Strategy 1: stored variants from collector
        const storedVariants = (doc.articleVideoVariants as { url: string; bitrate: number; content_type: string }[]) ?? []
        if (storedVariants.length > 0) {
          ctx.log.info(`Using ${storedVariants.length} stored video variants for ${docId}`)
          const mp4Variants = storedVariants.filter((v) => v.content_type === "video/mp4")
          const chosen = selectVariant(
            mp4Variants.map((v) => ({ url: v.url, bitrate: v.bitrate, content_type: v.content_type })),
            videoQuality,
          )
          if (chosen) {
            const cleanUrl = stripQueryParams(chosen.url)
            ctx.log.info(`Downloading video (bitrate: ${chosen.bitrate ?? "unknown"}) from stored variant`)
            const videoResp = await fetch(cleanUrl, {
              signal: AbortSignal.timeout(VIDEO_DOWNLOAD_TIMEOUT_MS),
              headers: { "User-Agent": "latent-info/1.0" },
            })
            if (videoResp.ok) {
              const buf = Buffer.from(await videoResp.arrayBuffer())
              if (buf.length > 0) {
                const bitrate = chosen.bitrate ?? 0
                downloadedVideo = {
                  url: chosen.url,
                  contentType: "video/mp4",
                  filename: "video_0.mp4",
                  data: buf,
                  type: "video",
                  bitrate,
                  resolution: guessResolution(bitrate),
                }
              }
            }
          }
        }

        // Strategy 2: syndication API
        if (!downloadedVideo) {
          downloadedVideo = await downloadVideo(tweetId, videoQuality, ctx.log)
        }
      } catch (e: unknown) {
        ctx.log.warn(`Video download failed for ${docId}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // Build article metadata
    const collectData = JSON.stringify({
      docId,
      title: articleTitle,
      text: (doc.text as string) ?? "",
      handle: (doc.handle as string) ?? "",
      displayName: (doc.displayName as string) ?? "",
      url: (doc.url as string) ?? "",
      imageUrls: articleImageUrls,
    })

    // Write markdown + media to filesystem
    const outputDir = getDownloadDir(config)
    const { markdownPath, mediaData, markdown: linkedMarkdown } = writeToFilesystem(
      outputDir, articleTitle, docId, markdown,
      downloadedImages, downloadedVideo, ctx.log,
    )

    const now = new Date().toISOString()

    // Compute source_key matching storeClip format: auto:x_article:{sha256(url).slice(0,16)}
    const docUrl = (doc.url as string) ?? ""
    const dedupInput = docUrl || docId
    const dedupHash = createHash("sha256").update(dedupInput).digest("hex").slice(0, 16)
    const sourceKey = `auto:x_article:${dedupHash}`

    const articleRow: ArticleRow = {
      id: `${docId}:${now}`,
      source_key: sourceKey,
      collect_data: collectData,
      content: cleanedHtml,
      markdown: linkedMarkdown,
      media_data: mediaData,
      markdown_path: markdownPath,
      created_at: now,
    }

    await insertArticle(articleRow)
    ctx.log.info(`Stored article ${docId}`)

    // Update SQLite document: mark as processed
    const updatedInfo = {
      ...info,
      articleProcessed: true,
      x_article_job_run: runCount,
    }
    doc.info = updatedInfo
    await ctx.db.execute({
      sql: "UPDATE documents SET doc = json(?) WHERE id = ?",
      args: [JSON.stringify(doc), docId],
    })

    return {
      docId,
      markdownLength: linkedMarkdown.length,
      imagesDownloaded: downloadedImages.length,
      imagesTotal: articleImageUrls.length,
      videoDownloaded: downloadedVideo !== null,
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    ctx.log.error(`Failed to process article ${docId}: ${msg}`)

    const failCount = (typeof info.x_article_job_fails === "number" ? info.x_article_job_fails : 0) + 1
    const updatedInfo = { ...info, x_article_job_run: runCount, x_article_job_fails: failCount }
    doc.info = updatedInfo

    try {
      await ctx.db.execute({
        sql: "UPDATE documents SET doc = json(?) WHERE id = ?",
        args: [JSON.stringify(doc), docId],
      })
    } catch {
      ctx.log.error(`Failed to update fail count for ${docId}`)
    }

    return { error: msg, docId }
  }
}

export default webClipMarkdownJob

export const __test__ = {
  collectClipImageUrls,
}
