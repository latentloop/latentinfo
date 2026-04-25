/**
 * GitHub collector CDP handler.
 *
 * One-shot scraper for repository pages. It fetches README markdown through the
 * GitHub API from the page context, deduplicates by README SHA, and stores the
 * latest README document for each repository.
 */

import type { Client } from "@libsql/client"
import type { PageProxy } from "../../collector-runner.js"
import type { GithubDocument, GithubReadmeImage } from "./types.js"
import { fetchCachedImages } from "../media-cache.js"
import { extractReadme, addBadge } from "./page-functions.js"
import { createLogger } from "../../logger.js"
import { broadcastSseEvent } from "../../server.js"

const log = createLogger("github")
const MODULE_NAME = "li_github"
const MAX_README_IMAGES = 50

interface RawGithubReadme {
  owner: string
  repo: string
  fullName: string
  description: string
  defaultBranch: string
  stars: number
  forks: number
  language: string
  readmePath: string
  readmeSha: string
  readmeMarkdown: string
  readmeText: string
  imageUrls: string[]
  htmlUrl: string
  rawUrl: string
  url: string
}

interface ExistingGithubDoc {
  collectedAt: string
  readmeSha: string
  readmeMarkdown: string
  readmeImagesCount: number
}

interface ReadmeImageCandidate {
  originalUrl: string
  resolvedUrl: string
}

function normalizeImageSource(value: string | undefined): string | null {
  const trimmed = (value || "").trim().replace(/^<|>$/g, "")
  if (!trimmed || trimmed.startsWith("#")) return null
  if (/^(data|blob|javascript):/i.test(trimmed)) return null
  return trimmed
}

function extractMarkdownImageSources(markdown: string): string[] {
  const sources: string[] = []
  const add = (value: string | undefined) => {
    const source = normalizeImageSource(value)
    if (source) sources.push(source)
  }

  const inlineImage = /!\[[^\]]*]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)]*["'])?\s*\)/g
  let match: RegExpExecArray | null
  while ((match = inlineImage.exec(markdown)) !== null) add(match[1])

  const referenceDefs = new Map<string, string>()
  const referenceDef = /^\s*\[([^\]]+)]\s*:\s*(\S+)/gm
  while ((match = referenceDef.exec(markdown)) !== null) {
    const key = match[1]?.trim().toLowerCase()
    const value = normalizeImageSource(match[2])
    if (key && value) referenceDefs.set(key, value)
  }

  const referenceImage = /!\[([^\]]*)]\[([^\]]*)]/g
  while ((match = referenceImage.exec(markdown)) !== null) {
    const key = (match[2] || match[1] || "").trim().toLowerCase()
    add(referenceDefs.get(key))
  }

  const htmlImage = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^'"\s>]+))/gi
  while ((match = htmlImage.exec(markdown)) !== null) add(match[1] || match[2] || match[3])

  return sources
}

function resolveReadmeImageUrl(source: string, rawUrl: string, repoUrl: string): string | null {
  const normalized = normalizeImageSource(source)
  if (!normalized) return null

  try {
    if (/^https?:\/\//i.test(normalized)) return normalized
    if (normalized.startsWith("//")) return `https:${normalized}`
    if (normalized.startsWith("/")) return new URL(normalized, "https://github.com").href
    if (rawUrl) return new URL(normalized, rawUrl).href
    return new URL(normalized, repoUrl.endsWith("/") ? repoUrl : `${repoUrl}/`).href
  } catch {
    return null
  }
}

function collectReadmeImageCandidates(raw: RawGithubReadme): ReadmeImageCandidate[] {
  const candidates: ReadmeImageCandidate[] = []
  const seen = new Set<string>()

  const add = (originalUrl: string, resolvedUrl: string | null) => {
    if (!resolvedUrl || !/^https?:\/\//i.test(resolvedUrl)) return
    const key = `${originalUrl}\n${resolvedUrl}`
    if (seen.has(key)) return
    seen.add(key)
    candidates.push({ originalUrl, resolvedUrl })
  }

  const markdownSources = extractMarkdownImageSources(raw.readmeMarkdown || "")
  const renderedSources = raw.imageUrls || []

  for (let i = 0; i < markdownSources.length; i++) {
    const source = markdownSources[i]!
    add(source, resolveReadmeImageUrl(source, raw.rawUrl, raw.url))
    const renderedSource = renderedSources[i]
    if (renderedSource) add(source, resolveReadmeImageUrl(renderedSource, raw.rawUrl, raw.url))
  }
  for (const source of renderedSources) {
    add(source, resolveReadmeImageUrl(source, raw.rawUrl, raw.url))
  }

  return candidates.slice(0, MAX_README_IMAGES)
}

async function collectReadmeImages(
  page: PageProxy,
  candidates: ReadmeImageCandidate[],
): Promise<GithubReadmeImage[]> {
  if (candidates.length === 0) return []

  try {
    const cached = await fetchCachedImages(page, candidates.map((candidate) => candidate.resolvedUrl))
    const images: GithubReadmeImage[] = []
    for (const candidate of candidates) {
      const dataUri = cached.get(candidate.resolvedUrl)
      if (!dataUri) continue
      images.push({
        originalUrl: candidate.originalUrl,
        resolvedUrl: candidate.resolvedUrl,
        dataUri,
      })
    }
    return images
  } catch (e: unknown) {
    log.debug(`README image cache fetch skipped: ${e instanceof Error ? e.message : e}`)
    return []
  }
}

function countReadmeImages(rawImages: unknown): number {
  if (Array.isArray(rawImages)) return rawImages.length
  if (typeof rawImages !== "string" || !rawImages) return 0
  try {
    const parsed = JSON.parse(rawImages)
    return Array.isArray(parsed) ? parsed.length : 0
  } catch {
    return 0
  }
}

export function createPageHandler(page: PageProxy, db: Client): void {
  async function findExistingDoc(docId: string): Promise<ExistingGithubDoc | null> {
    try {
      const result = await db.execute({
        sql: "SELECT json_extract(doc, '$.collectedAt') as ca, json_extract(doc, '$.readmeSha') as sha, json_extract(doc, '$.readmeMarkdown') as markdown, json_extract(doc, '$.readmeImages') as images FROM documents WHERE id = ? LIMIT 1",
        args: [docId],
      })
      if (result.rows.length === 0) return null
      return {
        collectedAt: (result.rows[0]!.ca as string) || "",
        readmeSha: (result.rows[0]!.sha as string) || "",
        readmeMarkdown: (result.rows[0]!.markdown as string) || "",
        readmeImagesCount: countReadmeImages(result.rows[0]!.images),
      }
    } catch {
      return null
    }
  }

  async function upsertDocument(docId: string, doc: GithubDocument): Promise<boolean> {
    try {
      await db.execute({
        sql: "INSERT INTO documents (id, doc) VALUES (?, json(?)) ON CONFLICT(id) DO UPDATE SET doc = excluded.doc",
        args: [docId, JSON.stringify(doc)],
      })
      return true
    } catch (e: unknown) {
      log.error(`DB write error: ${e instanceof Error ? e.message : e}`)
      return false
    }
  }

  void (async () => {
    try {
      const ready = await page.evaluate(`new Promise(function(resolve) {
        if (document.querySelector("#readme article, article.markdown-body, strong[itemprop='name'] a, [data-testid='repository-name-heading'] a")) {
          resolve(true);
          return;
        }
        var observer = new MutationObserver(function() {
          if (document.querySelector("#readme article, article.markdown-body, strong[itemprop='name'] a, [data-testid='repository-name-heading'] a")) {
            observer.disconnect();
            resolve(true);
          }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        setTimeout(function() { observer.disconnect(); resolve(false); }, 10000);
      })`)
      if (!ready) {
        log.debug("GitHub repository markers not found after waiting, skipping")
        return
      }

      await page.installModule(MODULE_NAME, {
        extractReadme,
        addBadge,
      })

      const raw = await page.callModule(MODULE_NAME, "extractReadme") as RawGithubReadme | null

      if (!raw || !raw.fullName || !raw.readmeMarkdown) {
        log.debug("No GitHub README found on page, skipping")
        return
      }

      const docId = `github:${raw.fullName}`
      const existing = await findExistingDoc(docId)
      const sameReadme = Boolean(existing &&
        ((existing.readmeSha && existing.readmeSha === raw.readmeSha) ||
          (!raw.readmeSha && existing.readmeMarkdown === raw.readmeMarkdown)))
      const imageCandidates = collectReadmeImageCandidates(raw)
      const needsImageBackfill = sameReadme && imageCandidates.length > 0 && existing!.readmeImagesCount === 0

      if (existing && sameReadme && !needsImageBackfill) {
        await page.callModule(MODULE_NAME, "addBadge", { isNew: false, collectedAt: existing.collectedAt })
        log.debug(`README ${raw.fullName} already collected`)
        return
      }

      const readmeImages = await collectReadmeImages(page, imageCandidates)
      const doc: GithubDocument = {
        type: "github",
        owner: raw.owner,
        repo: raw.repo,
        fullName: raw.fullName,
        description: raw.description,
        defaultBranch: raw.defaultBranch,
        stars: raw.stars,
        forks: raw.forks,
        language: raw.language,
        readmePath: raw.readmePath,
        readmeSha: raw.readmeSha,
        readmeMarkdown: raw.readmeMarkdown,
        readmeText: raw.readmeText,
        readmeImages,
        htmlUrl: raw.htmlUrl,
        rawUrl: raw.rawUrl,
        url: raw.url,
        collectedAt: existing && sameReadme ? existing.collectedAt : new Date().toISOString(),
        collectedBy: "github",
      }

      const ok = await upsertDocument(docId, doc)
      if (ok) {
        await page.callModule(MODULE_NAME, "addBadge", { isNew: !sameReadme, collectedAt: doc.collectedAt })
        broadcastSseEvent("data-changed", { source: "github" })
        log.info(`${sameReadme ? "Backfilled README images" : "Collected README"}: ${raw.fullName}`)
      }
    } catch (e: unknown) {
      log.error(`GitHub collector scrape error: ${e instanceof Error ? e.message : e}`)
    }
  })()
}
