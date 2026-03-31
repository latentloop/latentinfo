/**
 * Article storage using SQLite.
 *
 * Stores article metadata and content in the shared SQLite database.
 * Media files (images, videos) and markdown files live on the filesystem;
 * their paths are tracked via the `markdown_path` column.
 *
 * The DB client is set once at startup via `setArticleDb()`.
 */

import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import type { Client } from "@libsql/client"
import { getProfileDir } from "../config.js"
import { createLogger } from "../logger.js"

const log = createLogger("article-db")

// ---------------------------------------------------------------------------
// Module-level DB client
// ---------------------------------------------------------------------------

let _db: Client | null = null

/** Set the SQLite client. Called once from server.ts startup. */
export function setArticleDb(client: Client): void {
  _db = client
  log.info("Article DB client set")
}

function db(): Client {
  if (!_db) throw new Error("Article DB not initialized — call setArticleDb() first")
  return _db
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of an article row for insertion. */
export interface ArticleRow {
  id: string
  source_key?: string
  collect_data: string
  content: string
  markdown: string
  media_data: string[]
  markdown_path?: string
  /** Absolute path to the markdown file on disk (resolved from output_dir + markdown_path). */
  markdown_full_path?: string
  created_at: string
}

/** Options for listing articles. */
export interface ListArticlesOpts {
  offset: number
  limit: number
  q?: string
  author?: string
  dateFrom?: string
  dateTo?: string
}

/** Return type for a single image lookup. */
export interface ArticleImage {
  data: Buffer
  metadata: string
}

// ---------------------------------------------------------------------------
// Config helpers (for getArticleImage — loads output_dir from job config)
// ---------------------------------------------------------------------------

function getOutputDir(): string {
  const configPath = join(getProfileDir(), "jobs", "web_clip_markdown", "config.json")
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>
      if (typeof cfg.download_dir === "string" && cfg.download_dir) return cfg.download_dir
      if (typeof cfg.output_dir === "string" && cfg.output_dir) return cfg.output_dir
    } catch { /* use default */ }
  }
  return join(getProfileDir(), "downloads", "web_clips")
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert a single article row into the articles table.
 *
 * Always appends — clips are versioned by source_key, and listArticles returns
 * the latest row per source_key using a window function.
 */
export async function insertArticle(article: ArticleRow): Promise<void> {
  await db().execute({
    sql: "INSERT INTO articles (id, source_key, collect_data, content, markdown, media_data, markdown_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    args: [
      article.id,
      article.source_key ?? null,
      article.collect_data,
      article.content,
      article.markdown,
      JSON.stringify(article.media_data),
      article.markdown_path ?? null,
      article.created_at,
    ],
  })
  log.info({ id: article.id, source_key: article.source_key }, "Inserted article")
}

/**
 * Update an existing article row with processed content.
 *
 * Used by the markdown job to write markdown, media data, and cleaned HTML
 * back to the same row that was created by storeClip().
 */
export async function updateArticle(
  id: string,
  fields: {
    content?: string
    markdown?: string
    media_data?: string[]
    markdown_path?: string
  },
): Promise<void> {
  const sets: string[] = []
  const args: (string | null)[] = []

  if (fields.content !== undefined) {
    sets.push("content = ?")
    args.push(fields.content)
  }
  if (fields.markdown !== undefined) {
    sets.push("markdown = ?")
    args.push(fields.markdown)
  }
  if (fields.media_data !== undefined) {
    sets.push("media_data = ?")
    args.push(JSON.stringify(fields.media_data))
  }
  if (fields.markdown_path !== undefined) {
    sets.push("markdown_path = ?")
    args.push(fields.markdown_path)
  }

  if (sets.length === 0) return

  args.push(id)
  await db().execute({
    sql: `UPDATE articles SET ${sets.join(", ")} WHERE id = ?`,
    args,
  })
  log.info({ id, updated: sets.map((s) => s.split(" =")[0]) }, "Updated article")
}

/**
 * Query a single article by id.
 * Returns the article without binary media for efficiency, or null if not found.
 */
export async function getArticle(
  id: string,
): Promise<ArticleRow | null> {
  const result = await db().execute({
    sql: "SELECT id, source_key, collect_data, content, markdown, media_data, markdown_path, created_at FROM articles WHERE id = ? LIMIT 1",
    args: [id],
  })
  if (result.rows.length > 0) return rowToArticle(result.rows[0]!)

  // Fallback: try matching by source_key (e.g. "x_article:b0ecfc8c50b9d4b8")
  const skResult = await db().execute({
    sql: "SELECT id, source_key, collect_data, content, markdown, media_data, markdown_path, created_at FROM articles WHERE source_key = ? ORDER BY created_at DESC LIMIT 1",
    args: [id],
  })
  if (skResult.rows.length > 0) return rowToArticle(skResult.rows[0]!)

  return null
}

/**
 * List articles with pagination and optional filtering.
 *
 * Uses a window function to get the latest row per source_key with version count.
 * - `q` performs a LIKE search on the collect_data column.
 * - `author` filters on collect_data containing the author string.
 * - `dateFrom` / `dateTo` filter on created_at (ISO string comparison).
 */
export async function listArticles(
  opts: ListArticlesOpts,
): Promise<(ArticleRow & { version_count: number })[]> {
  const filters: string[] = []
  const args: (string | number)[] = []

  if (opts.q) {
    filters.push("(collect_data LIKE ? OR content LIKE ?)")
    args.push(`%${opts.q}%`, `%${opts.q}%`)
  }
  if (opts.author) {
    filters.push("collect_data LIKE ?")
    args.push(`%${opts.author}%`)
  }
  if (opts.dateFrom) {
    filters.push("created_at >= ?")
    args.push(opts.dateFrom)
  }
  if (opts.dateTo) {
    filters.push("created_at <= ?")
    args.push(opts.dateTo)
  }

  const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : ""

  const sql = `
    WITH ranked AS (
      SELECT *,
        ROW_NUMBER() OVER (PARTITION BY COALESCE(source_key, id) ORDER BY created_at DESC) AS rn,
        COUNT(*) OVER (PARTITION BY COALESCE(source_key, id)) AS version_count
      FROM articles
      ${whereClause}
    )
    SELECT id, source_key, collect_data, content, markdown, media_data, markdown_path, created_at, version_count
    FROM ranked
    WHERE rn = 1
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `
  args.push(opts.limit, opts.offset)

  const result = await db().execute({ sql, args })
  return result.rows.map((row) => ({
    ...rowToArticle(row),
    version_count: Number(row.version_count ?? 1),
  }))
}

/**
 * Get all versions of an article by source_key, sorted newest first.
 * Falls back to matching by id for legacy rows without source_key.
 */
export async function getArticleVersions(
  sourceKey: string,
): Promise<ArticleRow[]> {
  try {
    let result = await db().execute({
      sql: "SELECT id, source_key, collect_data, content, markdown, media_data, markdown_path, created_at FROM articles WHERE source_key = ? ORDER BY created_at DESC",
      args: [sourceKey],
    })

    if (result.rows.length === 0) {
      // Fallback: legacy row where id = sourceKey
      result = await db().execute({
        sql: "SELECT id, source_key, collect_data, content, markdown, media_data, markdown_path, created_at FROM articles WHERE id = ? LIMIT 1",
        args: [sourceKey],
      })
    }

    return result.rows.map((row) => rowToArticle(row))
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    log.warn(`getArticleVersions failed for "${sourceKey}": ${msg}`)
    return []
  }
}

/**
 * Get a specific image binary and its metadata from an article.
 *
 * Reads the media_data JSON from SQLite, resolves the filesystem path
 * from markdown_path + output_dir, and returns the file contents.
 *
 * @param id - The article id
 * @param index - Zero-based index into the media_data array
 * @returns The image data and metadata JSON string, or null if not found
 */
export async function getArticleImage(
  id: string,
  index: number,
): Promise<ArticleImage | null> {
  const result = await db().execute({
    sql: "SELECT media_data, markdown_path FROM articles WHERE id = ? LIMIT 1",
    args: [id],
  })
  if (result.rows.length === 0) return null

  const row = result.rows[0]!
  const markdownPath = row.markdown_path as string | null
  if (!markdownPath) return null

  let mediaData: string[]
  try {
    mediaData = JSON.parse(String(row.media_data ?? "[]")) as string[]
  } catch {
    return null
  }

  if (index < 0 || index >= mediaData.length) return null

  const metadata = mediaData[index]!
  let filename: string
  try {
    const parsed = JSON.parse(metadata) as { filename?: string }
    filename = parsed.filename ?? `img_${index}.bin`
  } catch {
    return null
  }

  // Resolve: <output_dir>/<markdown_path without .md filename>/<slug>.md_Attachments/<filename>
  const outputDir = getOutputDir()
  const mdDir = dirname(markdownPath)
  const mdBasename = markdownPath.split("/").pop() ?? ""
  const attachDir = join(outputDir, mdDir, `${mdBasename}_Attachments`)
  const filePath = join(attachDir, filename)

  if (!existsSync(filePath)) {
    log.warn({ id, index, filePath }, "Media file not found on disk")
    return null
  }

  try {
    const data = Buffer.from(readFileSync(filePath))
    return { data, metadata }
  } catch (e: unknown) {
    log.warn({ id, index, error: e instanceof Error ? e.message : e }, "Failed to read media file")
    return null
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToArticle(row: Record<string, unknown>): ArticleRow {
  let mediaData: string[] = []
  try {
    mediaData = JSON.parse(String(row.media_data ?? "[]")) as string[]
  } catch {
    log.warn({ id: String(row.id) }, "media_data JSON parse failed, defaulting to empty")
  }

  const markdownPath = row.markdown_path ? String(row.markdown_path) : undefined

  return {
    id: String(row.id),
    source_key: row.source_key ? String(row.source_key) : undefined,
    collect_data: String(row.collect_data ?? ""),
    content: String(row.content ?? ""),
    markdown: String(row.markdown ?? ""),
    media_data: mediaData,
    markdown_path: markdownPath,
    markdown_full_path: markdownPath ? join(getOutputDir(), markdownPath) : undefined,
    created_at: String(row.created_at ?? ""),
  }
}
