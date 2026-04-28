import test from "node:test"
import assert from "node:assert/strict"

import type { PageProxy } from "../collector-runner.js"
import { fetchCachedImages, __test__ } from "./media-cache.js"

test("media-cache payload limits stay bounded", () => {
  assert.equal(__test__.MAX_CACHED_IMAGES, 12)
  assert.equal(__test__.MAX_CACHED_IMAGE_BYTES, 3 * 1024 * 1024)
  assert.equal(__test__.MAX_CACHED_IMAGE_TOTAL_BYTES, 12 * 1024 * 1024)
})

test("fetchCachedImages dedupes URLs before page evaluation", async () => {
  let evaluated = ""
  const page: PageProxy = {
    url: "https://example.com",
    async evaluate(script) {
      evaluated = String(script)
      return {
        "https://example.com/a.png": "data:image/png;base64,aaa",
      }
    },
    async installModule() {},
    async callModule() { return null },
    async screenshot() { return Buffer.alloc(0) },
    onNotify() {},
    async disposeCollector() {},
    onCleanup() {},
  }

  const result = await fetchCachedImages(page, [
    "https://example.com/a.png",
    "https://example.com/a.png",
    "data:image/png;base64,inline",
  ])

  assert.equal(result.size, 1)
  assert.match(evaluated, /maxImages = 12/)
  assert.match(evaluated, /maxImageBytes = 3145728/)
  assert.match(evaluated, /maxTotalBytes = 12582912/)
})
