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
const MAX_CACHED_IMAGES = 12
const MAX_CACHED_IMAGE_BYTES = 3 * 1024 * 1024
const MAX_CACHED_IMAGE_TOTAL_BYTES = 12 * 1024 * 1024

export const __test__ = {
  MAX_CACHED_IMAGES,
  MAX_CACHED_IMAGE_BYTES,
  MAX_CACHED_IMAGE_TOTAL_BYTES,
}

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
        var maxImages = ${MAX_CACHED_IMAGES};
        var maxImageBytes = ${MAX_CACHED_IMAGE_BYTES};
        var maxTotalBytes = ${MAX_CACHED_IMAGE_TOTAL_BYTES};
        var results = {};
        var totalBytes = 0;
        var imageCount = 0;

        function readBlobAsDataUrl(blob) {
          return new Promise(function(resolve) {
            var reader = new FileReader();
            reader.onloadend = function() {
              resolve(typeof reader.result === "string" ? reader.result : null);
            };
            reader.onerror = function() { resolve(null); };
            reader.readAsDataURL(blob);
          });
        }

        for (var i = 0; i < urls.length; i++) {
          if (imageCount >= maxImages || totalBytes >= maxTotalBytes) break;
          var url = urls[i];
          try {
            var response = await fetch(url, { mode: "cors", cache: "force-cache" });
            if (!response.ok) continue;
            var blob = await response.blob();
            if (!blob || blob.size > maxImageBytes) continue;
            if (totalBytes + blob.size > maxTotalBytes) continue;
            var dataUri = await readBlobAsDataUrl(blob);
            if (!dataUri) continue;
            results[url] = dataUri;
            totalBytes += blob.size;
            imageCount++;
          } catch (e) {
            // skip failed fetches
          }
        }
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
