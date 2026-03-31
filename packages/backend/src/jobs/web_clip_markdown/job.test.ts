import test from "node:test"
import assert from "node:assert/strict"

import * as jobModule from "./job.js"

test("collectClipImageUrls falls back to collect_data imageUrls when HTML has no img tags", () => {
  const actual = jobModule.__test__?.collectClipImageUrls?.(
    "<article><p>No inline image tags here</p></article>",
    JSON.stringify({
      url: "https://x.com/someone/status/123",
      imageUrls: ["https://pbs.twimg.com/media/from-collect-data.jpg"],
    }),
  ) ?? []

  assert.deepEqual(actual, ["https://pbs.twimg.com/media/from-collect-data.jpg"])
})

test("collectClipImageUrls dedupes HTML and collect_data image URLs", () => {
  const actual = jobModule.__test__?.collectClipImageUrls?.(
    '<article><img src="https://pbs.twimg.com/media/shared.jpg"><img src="https://pbs.twimg.com/media/html-only.jpg"></article>',
    JSON.stringify({
      imageUrls: [
        "https://pbs.twimg.com/media/shared.jpg",
        "https://pbs.twimg.com/media/collect-only.jpg",
      ],
    }),
  ) ?? []

  assert.deepEqual(actual, [
    "https://pbs.twimg.com/media/shared.jpg",
    "https://pbs.twimg.com/media/collect-only.jpg",
    "https://pbs.twimg.com/media/html-only.jpg",
  ])
})
