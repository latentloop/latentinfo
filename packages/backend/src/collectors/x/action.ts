/**
 * X collector action handler — floating panel UI + keyboard skip logic.
 *
 * Ported from latent_webext_apps/x_x/action.js. Installs:
 * - Panel UI: skip button
 * - Page logic: ArrowUp/Down smart-scroll, focus dot, addBadges timestamp patch
 *
 * Fire-and-forget: called synchronously by collector-runner, runs async IIFE
 * internally. Page handler modules (window.__latent.x) may not be installed
 * yet — the addBadges patch uses a retry loop to wait.
 */

import type { Client } from "@libsql/client"
import type { PageProxy } from "../../collector-runner.js"
import { loadCollectorConfig, onCollectorConfigChanged, type CollectorSettings } from "../../collector-config.js"
import { createLogger } from "../../logger.js"
import {
  __xActionInitSkipBtn,
  __xActionInitPanel,
  injectActionLogic,
} from "./action-page-fns.js"

const log = createLogger("x-action")

export function createActionHandler(page: PageProxy, db: Client): void {
  void (async () => {
    try {
      // 1. Install panel UI module
      await page.installModule("x_action", {
        __xActionInitSkipBtn,
        __xActionInitPanel,
      })

      // 2. Create X section in shared panel
      await page.callModule("__panel", "__panelAddSection", { id: "x" })

      // 3. Populate X section with skip button
      await page.callModule("x_action", "__xActionInitPanel", { sectionId: "x" })

      // 4. Inject keyboard handler, scroll logic, focus dot, addBadges patch
      const config = loadCollectorConfig("x")
      const freshMin = config.freshMinutes ?? 0.5
      await injectActionLogic(page, "warn", freshMin)

      // 5. Update skip button label now that __latentFreshLabel is set
      //    (button was created in step 3 before injectActionLogic set the label)
      const initMs = Math.round(freshMin * 60000)
      await page.evaluate(`if(window.__latentSetFreshMs) window.__latentSetFreshMs(${initMs})`)
        .catch(() => {})

      // 6. Subscribe to config changes — push updated freshMinutes to this page immediately
      onCollectorConfigChanged((collectorId: string, newConfig: CollectorSettings) => {
        if (collectorId !== "x") return
        const ms = Math.round((newConfig.freshMinutes ?? 0.5) * 60000)
        page.evaluate(`if(window.__latentSetFreshMs) window.__latentSetFreshMs(${ms})`)
          .catch(() => {}) // silently ignore stale/closed pages
      })

      log.info("Action handler initialized")
    } catch (e: unknown) {
      log.error(`X action setup failed: ${e instanceof Error ? e.message : e}`)
    }
  })()
}
