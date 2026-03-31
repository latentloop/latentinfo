/**
 * Web clipper action handler — clip button in floating panel + backend storage.
 *
 * Installs the clipper page module (initClipMode, confirmSelection, etc.),
 * adds a scissors button to the shared panel, and listens for clip
 * notifications. On clip: stores raw HTML in SQLite, emits web_clip:collected,
 * and shows an in-page toast with clip status.
 *
 * Fire-and-forget: called synchronously by collector-runner, runs async IIFE
 * internally.
 */

import type { Client } from "@libsql/client"
import type { PageProxy } from "../../collector-runner.js"
import { loadCollectorConfig } from "../../collector-config.js"
import { onJobEvent } from "../../job-runner.js"
import { createLogger } from "../../logger.js"
import { getMatchingAutoPattern, getPatternForUrl } from "./auto-detect.js"
import { storeClip } from "./store-clip.js"
import {
  initClipMode,
  exitClipMode,
  adjustSelection,
  confirmSelection,
  initClipButton,
  initAutoClipButton,
  showClipToast,
} from "./clipper-page-fns.js"

const log = createLogger("web-clipper-action")

export function createActionHandler(page: PageProxy, _db: Client): void {
  void (async () => {
    try {
      // 1. Install clipper page module
      await page.installModule("li_web_clip", {
        initClipMode,
        exitClipMode,
        adjustSelection,
        confirmSelection,
        // temporarily comment out
        //initClipButton,
        initAutoClipButton,
        showClipToast,
      })

      // 2. Create web_clipper section in shared panel
      await page.callModule("__panel", "__panelAddSection", { id: "web_clip" })

      // 3. Conditionally add auto-clip button (before manual clip so it appears on the left)
      //    Show the button whenever the URL matches a known pattern, regardless of the
      //    auto-detect toggle — the toggle only controls automatic triggering.
      const autoMatch = getPatternForUrl(page.url)
      if (autoMatch) {
        await page.callModule("li_web_clip", "initAutoClipButton", { sectionId: "web_clip" })
      }

      // 4. Initialize the manual clip button in the panel section
      // temporarily comment out (matches installModule above)
      //await page.callModule("li_web_clip", "initClipButton", { sectionId: "web_clip" })

      // 4. Listen for clip notifications from the page
      page.onNotify((payload: string) => {
        let data: { type?: string; html?: string; url?: string; title?: string; selector?: string; handle?: string; displayName?: string; avatarUrl?: string }
        try {
          data = JSON.parse(payload) as typeof data
        } catch {
          return // not JSON — ignore
        }
        // Handle auto-clip trigger from the auto button
        if (data.type === "auto-clip") {
          if (!autoMatch) return
          void (async () => {
            try {
              const result = await autoMatch.extract(page)
              if (!result) {
                await page.callModule("li_web_clip", "showClipToast", {
                  sourceKey: "",
                  status: "error",
                  message: "Auto-clip: no content found",
                })
                return
              }
              const stored = await storeClip({
                html: result.html,
                url: result.url,
                title: result.title,
                imageUrls: result.imageUrls,
                patternId: autoMatch.patternId,
                handle: result.handle || result.author,
                displayName: result.displayName,
                avatarUrl: result.avatarUrl,
                tweetDate: result.tweetDate,
              })
              if (stored) {
                await page.callModule("li_web_clip", "showClipToast", {
                  sourceKey: stored.sourceKey,
                  status: "stored",
                })
              } else {
                await page.callModule("li_web_clip", "showClipToast", {
                  sourceKey: "",
                  status: "error",
                  message: "Failed to save auto-clip",
                })
              }
            } catch (e: unknown) {
              log.error({
                url: page.url,
                error: e instanceof Error ? e.message : e,
              }, "Auto-clip failed")
              try {
                await page.callModule("li_web_clip", "showClipToast", {
                  sourceKey: "",
                  status: "error",
                  message: "Auto-clip failed",
                })
              } catch { /* page may have navigated */ }
            }
          })()
          return
        }

        if (data.type !== "clip") return

        const html = data.html ?? ""
        if (!html) {
          log.warn("Clip notification with empty HTML, skipping")
          return
        }

        void (async () => {
          try {
            const result = await storeClip({
              html, url: data.url, title: data.title, selector: data.selector,
              handle: data.handle, displayName: data.displayName, avatarUrl: data.avatarUrl,
            })
            if (result) {
              // Show toast on the page with clip info
              try {
                await page.callModule("li_web_clip", "showClipToast", {
                  sourceKey: result.sourceKey,
                  status: "stored",
                })
              } catch { /* page may have navigated */ }
            } else {
              try {
                await page.callModule("li_web_clip", "showClipToast", {
                  sourceKey: "",
                  status: "error",
                  message: "Failed to save clip",
                })
              } catch { /* page may have navigated */ }
            }
          } catch {
            try {
              await page.callModule("li_web_clip", "showClipToast", {
                sourceKey: "",
                status: "error",
                message: "Failed to save clip",
              })
            } catch { /* page may have navigated */ }
          }
        })()
      })

      // 5. Listen for job completion to update toast
      const unsub = onJobEvent("job:run-completed", (payload?: unknown) => {
        const p = payload as { jobId?: string } | undefined
        if (p?.jobId !== "web_clip_markdown") return
        // Update toast — best-effort, page may be gone
        page.callModule("li_web_clip", "showClipToast", {
          sourceKey: "",
          status: "processed",
        }).catch(() => {})
      })
      // Store unsubscribe for potential cleanup
      void unsub // currently no cleanup path needed — listener is lightweight

      log.info("Web clipper action handler initialized")
    } catch (e: unknown) {
      log.error(`Web clipper action setup failed: ${e instanceof Error ? e.message : e}`)
    }
  })()
}
