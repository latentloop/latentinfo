/**
 * Fetch cached images from the browser via page.evaluate().
 *
 * Uses fetch() in the page context. The browser may serve already-loaded images
 * from its HTTP cache, avoiding new network requests. Returns base64 data URIs
 * that can be stored directly in document fields.
 */

import type { PageProxy } from "../collector-runner.js"
import { createLogger } from "../logger.js"

const log = createLogger("media-cache")

/**
 * Fetch a batch of image URLs from the page context, returning base64 data URIs.
 *
 * @returns Map of original URL -> data:image/...;base64,... URI. Missing entries = fetch failed.
 */
export async function fetchCachedImages(
  page: PageProxy,
  urls: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  if (urls.length === 0) return result

  const unique = [...new Set(urls.filter((u) => u && u.startsWith("http")))]
  if (unique.length === 0) return result

  try {
    const dataUris = await page.evaluate(`
      (async function() {
        var urls = ${JSON.stringify(unique)};
        var results = {};
        var promises = urls.map(function(url) {
          return fetch(url, { mode: "cors", cache: "force-cache" })
            .then(function(r) { return r.ok ? r.blob() : null; })
            .then(function(blob) {
              if (!blob) return;
              return new Promise(function(resolve) {
                var reader = new FileReader();
                reader.onloadend = function() { results[url] = reader.result; resolve(); };
                reader.onerror = function() { resolve(); };
                reader.readAsDataURL(blob);
              });
            })
            .catch(function() { /* skip failed fetches */ });
        });
        await Promise.all(promises);
        return results;
      })()
    `) as Record<string, string> | null

    if (dataUris) {
      for (const [url, dataUri] of Object.entries(dataUris)) {
        if (dataUri && dataUri.startsWith("data:")) {
          result.set(url, dataUri)
        }
      }
    }

    log.info(`Fetched ${result.size}/${unique.length} cached images`)
  } catch (e: unknown) {
    log.debug(`Image cache fetch failed: ${e instanceof Error ? e.message : e}`)
  }

  return result
}
