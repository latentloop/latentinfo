/**
 * arxiv_dl job — downloads arXiv paper assets (PDF, TeX, markdown) via direct HTTP.
 *
 * Triggered by arxiv:collected event (default off) or manual run.
 * With params: { arxiv_id: "2301.07041" } downloads a single paper.
 * Without params: batch-processes unprocessed papers from DB.
 * Tracks per-document fail counts. Downloads to <profile_dir>/downloads/arxiv_dl/<arxiv_id>/
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"
import { execFileSync } from "node:child_process"
import type { JobDefinition, JobContext } from "../types.js"
import { getProfileDir } from "../../config.js"
import { parseArxivId } from "../../utils/parse-arxiv-ids.js"

const DEBOUNCE_MS = 5000
const BATCH_SIZE = 5
const MAX_FAILS = 3
const DOWNLOAD_TIMEOUT_MS = 60_000

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface JobConfig {
  download_dir?: string
  enable_tex?: boolean
  enable_hf_markdown?: boolean
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
  return config.download_dir ?? join(getProfileDir(), "downloads", "arxiv_dl")
}

// ---------------------------------------------------------------------------
// ArXiv metadata API
// ---------------------------------------------------------------------------

interface ArxivMeta {
  title: string
  authors: string[]
  abstract: string
  categories: string[]
  latestVersion: number
  published: string
  updated: string
}

async function fetchArxivMeta(arxivId: string, log: JobContext["log"]): Promise<ArxivMeta | null> {
  const url = `https://export.arxiv.org/api/query?id_list=${arxivId}`
  const delays = [3000, 6000, 12000]

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(15000) })
      if (resp.status === 429) {
        if (attempt < delays.length) {
          log.warn(`arXiv API rate limited, retrying in ${delays[attempt]! / 1000}s...`)
          await new Promise((r) => setTimeout(r, delays[attempt]!))
          continue
        }
        log.error("arXiv API rate limited after all retries")
        return null
      }
      if (!resp.ok) {
        log.error(`arXiv API returned ${resp.status}`)
        return null
      }

      const xml = await resp.text()
      return parseAtomXml(xml)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (attempt < delays.length) {
        log.warn(`arXiv API error: ${msg}, retrying...`)
        await new Promise((r) => setTimeout(r, delays[attempt]!))
        continue
      }
      log.error(`arXiv API error after all retries: ${msg}`)
      return null
    }
  }
  return null
}

/** Minimal Atom XML parser — extracts fields from arXiv API response. */
function parseAtomXml(xml: string): ArxivMeta | null {
  // Check if any entry was found
  if (!xml.includes("<entry>")) return null

  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1]
  if (!entry) return null

  const tag = (name: string): string =>
    entry.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`))?.[1]?.trim() ?? ""

  const title = tag("title").replace(/\s+/g, " ")
  const abstract = tag("summary").replace(/\s+/g, " ")
  const published = tag("published")
  const updated = tag("updated")

  // Authors: multiple <author><name>...</name></author>
  const authors: string[] = []
  const authorRe = /<author>\s*<name>([^<]+)<\/name>/g
  let m: RegExpExecArray | null
  while ((m = authorRe.exec(entry)) !== null) {
    authors.push(m[1]!.trim())
  }

  // Categories: <category term="cs.AI" />
  const categories: string[] = []
  const catRe = /<category[^>]+term="([^"]+)"/g
  while ((m = catRe.exec(entry)) !== null) {
    categories.push(m[1]!)
  }

  // Latest version: extract from <id> which contains e.g. http://arxiv.org/abs/2301.07041v3
  const idTag = tag("id")
  const versionMatch = idTag.match(/v(\d+)$/)
  const latestVersion = versionMatch ? parseInt(versionMatch[1]!, 10) : 1

  if (!title) return null

  return { title, authors, abstract, categories, latestVersion, published, updated }
}

// ---------------------------------------------------------------------------
// Direct HTTP download helpers
// ---------------------------------------------------------------------------

/** Download a file via HTTP fetch. Returns the saved filename or null on failure. */
async function httpDownload(
  url: string,
  destDir: string,
  filename: string,
  log: JobContext["log"],
): Promise<string | null> {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      headers: { "User-Agent": "latent-info/1.0" },
    })
    if (!resp.ok) {
      log.error(`HTTP ${resp.status} downloading ${url}`)
      return null
    }

    const buf = Buffer.from(await resp.arrayBuffer())
    if (buf.length === 0) {
      log.error(`Empty response downloading ${url}`)
      return null
    }

    const filePath = join(destDir, filename)
    writeFileSync(filePath, buf)
    log.info(`Downloaded ${filename} (${(buf.length / 1024).toFixed(0)} KB)`)
    return filename
  } catch (e: unknown) {
    log.error(`Download failed ${url}: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// TeX extraction
// ---------------------------------------------------------------------------

/** Extract tar archive contents from a buffer. Minimal tar parser (512-byte blocks). */
function extractTar(tarData: Buffer, destDir: string): string[] {
  const files: string[] = []
  let offset = 0

  while (offset + 512 <= tarData.length) {
    // Read header block (512 bytes)
    const header = tarData.subarray(offset, offset + 512)

    // Check for end-of-archive (two zero blocks)
    if (header.every((b) => b === 0)) break

    // Extract filename (bytes 0-99)
    const nameEnd = header.indexOf(0, 0)
    const name = header.subarray(0, Math.min(nameEnd >= 0 ? nameEnd : 100, 100)).toString("utf-8").trim()
    if (!name) break

    // Extract file size (bytes 124-135, octal)
    const sizeStr = header.subarray(124, 136).toString("utf-8").trim()
    const size = parseInt(sizeStr, 8) || 0

    // Type flag (byte 156): '0' or '\0' = regular file, '5' = directory
    const typeFlag = header[156]

    offset += 512 // Move past header

    if ((typeFlag === 0x30 || typeFlag === 0x00) && size > 0) {
      // Regular file — extract
      const content = tarData.subarray(offset, offset + size)
      // Sanitize: prevent directory traversal
      const safeName = name.replace(/\.\./g, "_").replace(/^\//, "")
      const filePath = join(destDir, safeName)

      // Create subdirectories if needed
      const dir = join(filePath, "..")
      mkdirSync(dir, { recursive: true })

      writeFileSync(filePath, content)
      files.push(safeName)
    }

    // Advance to next 512-byte boundary
    offset += Math.ceil(size / 512) * 512
  }

  return files
}

/**
 * Process a downloaded e-print file: detect format (tar.gz, gzip, plain tex)
 * and extract to the tex/ subdirectory.
 */
function extractEprint(filePath: string, texDir: string, log: JobContext["log"]): boolean {
  try {
    const raw = readFileSync(filePath)
    mkdirSync(texDir, { recursive: true })

    // Try to gunzip first
    let decompressed: Buffer
    try {
      decompressed = gunzipSync(raw)
    } catch {
      // Not gzipped — treat as plain tex
      writeFileSync(join(texDir, "main.tex"), raw)
      log.info("Extracted plain TeX source")
      return true
    }

    // Check if decompressed data is a tar archive (starts with a filename followed by null bytes in header)
    // Tar files have a "ustar" magic at offset 257
    const ustarMagic = decompressed.subarray(257, 262).toString("utf-8")
    if (ustarMagic === "ustar") {
      const files = extractTar(decompressed, texDir)
      log.info(`Extracted ${files.length} files from tar archive`)
      return true
    }

    // Not tar — single gzipped file
    writeFileSync(join(texDir, "main.tex"), decompressed)
    log.info("Extracted gzipped TeX source")
    return true
  } catch (e: unknown) {
    log.error(`TeX extraction failed: ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

// ---------------------------------------------------------------------------
// HF markdown generation
// ---------------------------------------------------------------------------

function tryHfMarkdown(arxivId: string, paperDir: string, log: JobContext["log"]): "success" | "skipped" | "error" {
  // Check if hf CLI exists
  try {
    execFileSync("which", ["hf"], { timeout: 5000, stdio: "pipe" })
  } catch {
    log.debug("hf CLI not found, skipping markdown generation")
    return "skipped"
  }

  try {
    const stdout = execFileSync("hf", ["papers", "read", arxivId], {
      timeout: 60000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    })
    if (stdout && stdout.trim()) {
      writeFileSync(join(paperDir, `${arxivId}.md`), stdout)
      log.info(`Generated markdown via hf CLI: ${arxivId}.md`)
      return "success"
    }
    log.warn("hf papers read returned empty output")
    return "error"
  } catch (e: unknown) {
    log.warn(`hf papers read failed: ${e instanceof Error ? e.message : String(e)}`)
    return "error"
  }
}

// ---------------------------------------------------------------------------
// Job definition
// ---------------------------------------------------------------------------

const arxivDlJob: JobDefinition = {
  id: "arxiv_dl",
  description: "Download arXiv paper assets (PDF, TeX, markdown)",

  register(ctx) {
    // Default event_enabled to false (opt-in via dashboard Switch)
    const configPath = join(ctx.jobDir, "config.json")
    let config: Record<string, unknown> = {}
    try {
      if (existsSync(configPath)) {
        config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>
      }
    } catch { /* ignore */ }
    let changed = false
    if (!("event_enabled" in config)) { config.event_enabled = false; changed = true }
    if (!("enable_tex" in config)) { config.enable_tex = false; changed = true }
    if (changed) {
      mkdirSync(ctx.jobDir, { recursive: true })
      writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8")
    }

    ctx.on("arxiv:collected", () => {})
  },

  async run(ctx) {
    // Concurrency is managed by the job-runner's drain queue — no per-job guard needed.
    return await arxivDlRunInner(ctx)
  },
}

/** Download a single paper's assets via direct HTTP. Returns a result record. */
async function downloadPaper(
  arxivId: string,
  config: JobConfig,
  ctx: JobContext,
): Promise<Record<string, unknown>> {
  const downloadDir = getDownloadDir(config)
  const paperDir = join(downloadDir, arxivId)
  mkdirSync(paperDir, { recursive: true })

  const result: Record<string, unknown> = {
    arxiv_id: arxivId,
    paper_dir: paperDir,
    pdf: "pending",
    tex: "pending",
    hf_markdown: "pending",
  }

  // Fetch metadata
  const meta = await fetchArxivMeta(arxivId, ctx.log)
  if (meta) {
    ctx.log.info(`Paper: ${meta.title.slice(0, 80)} (v${meta.latestVersion})`)
    writeFileSync(join(paperDir, "meta.json"), JSON.stringify({
      arxiv_id: arxivId,
      title: meta.title,
      authors: meta.authors,
      abstract: meta.abstract,
      categories: meta.categories,
      latest_version: meta.latestVersion,
      published: meta.published,
      updated: meta.updated,
      downloaded_at: new Date().toISOString(),
    }, null, 2))
    result.title = meta.title
    result.version = meta.latestVersion
  } else {
    ctx.log.warn("Could not fetch metadata — continuing with downloads")
    result.metadata = "failed"
  }

  // Download PDF via direct HTTP fetch
  ctx.log.info(`Downloading PDF for ${arxivId}...`)
  const pdfFilename = `${arxivId}${meta ? `v${meta.latestVersion}` : ""}.pdf`
  const pdfOk = await httpDownload(
    `https://arxiv.org/pdf/${arxivId}`,
    paperDir,
    pdfFilename,
    ctx.log,
  )
  if (pdfOk) {
    result.pdf = "success"
    result.pdf_file = pdfFilename
  } else {
    result.pdf = "failed"
  }

  // Download TeX source via direct HTTP fetch
  if (!config.enable_tex) {
    ctx.log.info("TeX download skipped (disabled in config)")
    result.tex = "skipped"
  } else {
    ctx.log.info(`Downloading TeX source for ${arxivId}...`)
    const eprintFilename = `${arxivId}.eprint`
    const texOk = await httpDownload(
      `https://arxiv.org/e-print/${arxivId}`,
      paperDir,
      eprintFilename,
      ctx.log,
    )
    if (texOk) {
      const texDir = join(paperDir, "tex")
      const eprintPath = join(paperDir, eprintFilename)
      const ok = extractEprint(eprintPath, texDir, ctx.log)
      result.tex = ok ? "success" : "extraction_failed"
      try { unlinkSync(eprintPath) } catch { /* best effort */ }
    } else {
      result.tex = "failed"
    }
  }

  // Generate markdown via hf CLI
  if (!config.enable_hf_markdown) {
    ctx.log.info("HF markdown skipped (disabled in config)")
    result.hf_markdown = "skipped"
  } else {
    result.hf_markdown = tryHfMarkdown(arxivId, paperDir, ctx.log)
  }

  return { ...result, downloadPath: paperDir }
}

async function arxivDlRunInner(ctx: JobContext): Promise<Record<string, unknown>> {
  const config = loadJobConfig(ctx.jobDir)

  // Fast-path: manual run with specific arxiv_id
  const rawId = ctx.params?.arxiv_id
  if (rawId && typeof rawId === "string") {
    const arxivId = parseArxivId(rawId)
    if (!arxivId) {
      ctx.log.error(`Could not parse arxiv ID from: ${rawId}`)
      return { error: `Could not parse arxiv ID from: ${rawId}` }
    }

    ctx.log.info(`Manual download: ${arxivId}`)
    const result = await downloadPaper(arxivId, config, ctx)

    // Update document with downloadPath
    const docId = `arxiv:${arxivId}`
    try {
      const docResult = await ctx.db.execute({ sql: "SELECT doc FROM documents WHERE id = ?", args: [docId] })
      if (docResult.rows.length > 0) {
        const doc = typeof docResult.rows[0]!.doc === "string"
          ? JSON.parse(docResult.rows[0]!.doc as string) as Record<string, unknown>
          : docResult.rows[0]!.doc as unknown as Record<string, unknown>
        const info = (doc.info as Record<string, unknown>) ?? {}
        doc.info = { ...info, downloadPath: result.downloadPath, arxiv_dl_job_run: ((info.arxiv_dl_job_run as number) || 0) + 1 }
        await ctx.db.execute({ sql: "UPDATE documents SET doc = json(?) WHERE id = ?", args: [JSON.stringify(doc), docId] })
      }
    } catch (e: unknown) {
      ctx.log.warn(`Failed to update document: ${e instanceof Error ? e.message : e}`)
    }

    await ctx.recordRun(result)
    ctx.invalidateCache()
    ctx.log.info(`arxiv_dl manual complete: PDF=${result.pdf}, TeX=${result.tex}, HF=${result.hf_markdown}`)
    return result
  }

  // Fast-path: manual run with multiple arxiv_ids
  const rawIds = ctx.params?.arxiv_ids
  if (Array.isArray(rawIds) && rawIds.length > 0) {
    const arxivIds = rawIds.map((id: unknown) => typeof id === "string" ? parseArxivId(id) : null).filter((id): id is string => id !== null)
    if (arxivIds.length === 0) {
      ctx.log.error("No valid arxiv IDs in params")
      return { error: "No valid arxiv IDs in params" }
    }

    ctx.log.info(`Manual download: ${arxivIds.length} papers`)
    const results: Record<string, unknown>[] = []
    for (const arxivId of arxivIds) {
      try {
        const result = await downloadPaper(arxivId, config, ctx)
        // Update document with downloadPath
        const docId = `arxiv:${arxivId}`
        try {
          const docResult = await ctx.db.execute({ sql: "SELECT doc FROM documents WHERE id = ?", args: [docId] })
          if (docResult.rows.length > 0) {
            const doc = typeof docResult.rows[0]!.doc === "string"
              ? JSON.parse(docResult.rows[0]!.doc as string) as Record<string, unknown>
              : docResult.rows[0]!.doc as unknown as Record<string, unknown>
            const info = (doc.info as Record<string, unknown>) ?? {}
            doc.info = { ...info, downloadPath: result.downloadPath, arxiv_dl_job_run: ((info.arxiv_dl_job_run as number) || 0) + 1 }
            await ctx.db.execute({ sql: "UPDATE documents SET doc = json(?) WHERE id = ?", args: [JSON.stringify(doc), docId] })
          }
        } catch (e: unknown) {
          ctx.log.warn(`Failed to update document: ${e instanceof Error ? e.message : e}`)
        }
        results.push(result)
        ctx.log.info(`Downloaded ${arxivId}: PDF=${result.pdf}, TeX=${result.tex}`)
      } catch (e: unknown) {
        ctx.log.error(`Failed to download ${arxivId}: ${e instanceof Error ? e.message : e}`)
        results.push({ arxiv_id: arxivId, error: e instanceof Error ? e.message : String(e) })
      }
    }

    const aggregated = { papers: results, total: arxivIds.length, downloaded: results.filter((r) => !r.error).length }
    await ctx.recordRun(aggregated)
    ctx.invalidateCache()
    return aggregated
  }

  // Batch mode: process undownloaded papers from DB

  // Debounce: skip if last successful run finished within DEBOUNCE_MS (unless manual)
  if (ctx.trigger !== "manual") {
    try {
      const recent = await ctx.db.execute({
        sql: "SELECT finished_at FROM job_runs WHERE job_id = 'arxiv_dl' AND status = 'success' AND finished_at IS NOT NULL ORDER BY started_at DESC LIMIT 1",
        args: [],
      })
      if (recent.rows.length > 0) {
        const lastFinish = new Date(String(recent.rows[0]!.finished_at)).getTime()
        if (Date.now() - lastFinish < DEBOUNCE_MS) {
          ctx.log.info("Skipping arxiv_dl run (within debounce window)")
          return { skipped: true, reason: "debounce" }
        }
      }
    } catch {
      // Proceed if debounce check fails
    }
  }

  // Query unprocessed arxiv documents
  const queryResult = await ctx.db.execute({
    sql: `SELECT id, doc FROM documents
          WHERE json_extract(doc, '$.collectedBy') = 'arxiv'
            AND json_extract(doc, '$.info.downloadPath') IS NULL
            AND (json_extract(doc, '$.info.arxiv_dl_job_fails') IS NULL
                 OR json_extract(doc, '$.info.arxiv_dl_job_fails') < ?)
          LIMIT ?`,
    args: [MAX_FAILS, BATCH_SIZE],
  })

  if (queryResult.rows.length === 0) {
    ctx.log.info("No undownloaded papers to process")
    const result = { downloaded: [], failed: [], total: 0 }
    if (ctx.trigger === "manual") await ctx.recordRun(result)
    return result
  }

  ctx.log.info(`Processing ${queryResult.rows.length} undownloaded papers`)

  const downloadedIds: string[] = []
  const failedIds: string[] = []

  for (const row of queryResult.rows) {
    const docId = String(row.id)
    const doc = JSON.parse(String(row.doc)) as Record<string, unknown>
    const arxivId = String(doc.arxivId ?? "")
    if (!arxivId) { failedIds.push(docId); continue }

    const info = (doc.info as Record<string, unknown>) ?? {}
    const runCount = (typeof info.arxiv_dl_job_run === "number" ? info.arxiv_dl_job_run : 0) + 1

    try {
      const result = await downloadPaper(arxivId, config, ctx)

      doc.info = { ...info, downloadPath: result.downloadPath, arxiv_dl_job_run: runCount }
      await ctx.db.execute({
        sql: "UPDATE documents SET doc = json(?) WHERE id = ?",
        args: [JSON.stringify(doc), docId],
      })
      downloadedIds.push(docId)
      ctx.log.info(`Downloaded ${docId}: PDF=${result.pdf}, TeX=${result.tex}`)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      ctx.log.error(`Failed to download ${docId}: ${msg}`)

      const failCount = (typeof info.arxiv_dl_job_fails === "number" ? info.arxiv_dl_job_fails : 0) + 1
      doc.info = { ...info, arxiv_dl_job_run: runCount, arxiv_dl_job_fails: failCount }
      try {
        await ctx.db.execute({
          sql: "UPDATE documents SET doc = json(?) WHERE id = ?",
          args: [JSON.stringify(doc), docId],
        })
      } catch {
        ctx.log.error(`Failed to update fail count for ${docId}`)
      }
      failedIds.push(docId)
    }
  }

  const batchResult = { downloaded: downloadedIds, failed: failedIds, total: queryResult.rows.length }

  const didWork = downloadedIds.length > 0 || failedIds.length > 0
  if (didWork || ctx.trigger === "manual") {
    await ctx.recordRun(batchResult)
    if (didWork) ctx.invalidateCache()
  }

  // If we processed a full batch, there may be more
  if (queryResult.rows.length >= BATCH_SIZE) {
    ctx.log.info("Full batch processed, triggering follow-up run")
    setTimeout(() => ctx.triggerRun(), DEBOUNCE_MS)
  }

  ctx.log.info(`arxiv_dl batch complete: ${downloadedIds.length} downloaded, ${failedIds.length} failed`)
  return batchResult
}

export default arxivDlJob
