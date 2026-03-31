/**
 * arxiv collector CDP handler.
 *
 * Simple one-shot scraper: extracts paper metadata from arxiv abstract pages,
 * deduplicates against the DB, stores new papers, and badges the page.
 * No MutationObserver or scroll watching — arxiv pages are static.
 */

import type { Client } from "@libsql/client"
import type { PageProxy } from "../../collector-runner.js"
import type { ArxivDocument } from "./types.js"
import { extractPaper, addBadge } from "./page-functions.js"
import { createLogger } from "../../logger.js"
import { emitJobEvent } from "../../job-runner.js"
import { broadcastSseEvent } from "../../server.js"

const log = createLogger("arxiv")
const MODULE_NAME = "li_arxiv"

export function createPageHandler(page: PageProxy, db: Client): void {
  async function findExistingDoc(docId: string): Promise<{ collectedAt: string } | null> {
    try {
      const result = await db.execute({
        sql: "SELECT json_extract(doc, '$.collectedAt') as ca FROM documents WHERE id = ? LIMIT 1",
        args: [docId],
      })
      if (result.rows.length === 0) return null
      return { collectedAt: (result.rows[0]!.ca as string) || "" }
    } catch {
      return null
    }
  }

  async function upsertDocument(docId: string, doc: ArxivDocument): Promise<boolean> {
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
      // 1. Wait for the page to have the arxiv title element (event-driven via MutationObserver)
      const ready = await page.evaluate(`new Promise(function(resolve) {
        if (document.querySelector('h1.title')) { resolve(true); return; }
        var observer = new MutationObserver(function() {
          if (document.querySelector('h1.title')) { observer.disconnect(); resolve(true); }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        setTimeout(function() { observer.disconnect(); resolve(false); }, 10000);
      })`)
      if (!ready) {
        log.debug("arxiv page title not found after waiting, skipping")
        return
      }

      // 2. Install page-side extraction module
      await page.installModule(MODULE_NAME, {
        extractPaper,
        addBadge,
      })

      // 3. Extract paper metadata
      const raw = await page.callModule(MODULE_NAME, "extractPaper") as {
        arxivId: string
        title: string
        authors: string[]
        abstract: string
        categories: string[]
        submittedAt: string
        pdfUrl: string
        url: string
        versions: { version: string; date: string; size: string }[]
      }

      if (!raw || !raw.arxivId) {
        log.debug("No arxiv ID found on page, skipping")
        return
      }

      const docId = `arxiv:${raw.arxivId}`
      const existing = await findExistingDoc(docId)

      if (existing) {
        await page.callModule(MODULE_NAME, "addBadge", { isNew: false, collectedAt: existing.collectedAt })
        log.debug(`Paper ${raw.arxivId} already collected`)
        return
      }

      // 3. Build and store document
      const doc: ArxivDocument = {
        arxivId: raw.arxivId,
        title: raw.title,
        authors: raw.authors,
        abstract: raw.abstract,
        categories: raw.categories,
        submittedAt: raw.submittedAt,
        pdfUrl: raw.pdfUrl,
        url: raw.url,
        versions: raw.versions?.length > 0 ? raw.versions : undefined,
        collectedAt: new Date().toISOString(),
        collectedBy: "arxiv",
      }

      const ok = await upsertDocument(docId, doc)
      if (ok) {
        await page.callModule(MODULE_NAME, "addBadge", { isNew: true, collectedAt: doc.collectedAt })
        emitJobEvent("arxiv:collected", { arxivId: raw.arxivId })
        broadcastSseEvent("data-changed", { source: "arxiv" })
        log.info(`Collected paper: ${raw.arxivId} — ${raw.title.slice(0, 60)}`)
      }
    } catch (e: unknown) {
      log.error(`arxiv scrape error: ${e instanceof Error ? e.message : e}`)
    }
  })()
}
