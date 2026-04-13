import test from "node:test"
import assert from "node:assert/strict"

import type { PageProxy } from "../../collector-runner.js"
import * as autoDetect from "./auto-detect.js"

test("extractGraphqlImageUrls collects image URLs from atomic entity data", () => {
  const actual = autoDetect.__test__?.extractGraphqlImageUrls?.(
    {
      "0": {
        type: "MEDIA",
        data: {
          url: "https://pbs.twimg.com/media/img0.jpg?format=jpg&name=large",
        },
      },
    },
    [{ key: 0 }],
  ) ?? []

  assert.deepEqual(actual, [
    "https://pbs.twimg.com/media/img0.jpg?format=jpg&name=large",
  ])
})

test("extractGraphqlImageUrls collects nested media URLs even when top-level url is absent", () => {
  const actual = autoDetect.__test__?.extractGraphqlImageUrls?.(
    {
      hero: {
        type: "IMAGE",
        data: {
          media: {
            media_url_https: "https://pbs.twimg.com/media/hero.png",
          },
        },
      },
    },
    [{ key: "hero" }],
  ) ?? []

  assert.deepEqual(actual, ["https://pbs.twimg.com/media/hero.png"])
})

test("getEffectiveAutoDetectConfig defaults to DOM and disables GraphQL", () => {
  const actual = autoDetect.__test__?.getEffectiveAutoDetectConfig?.({}) ?? null

  assert.deepEqual(actual, {
    x_article: true,
    x_article_graphql: false,
  })
})

test("getMatchingAutoPattern prefers DOM for X status URLs", () => {
  const actual = autoDetect.getMatchingAutoPattern("https://x.com/user/status/123", {})

  assert.equal(actual?.patternId, "x_article")
})

test("getMatchingAutoPattern does not enable GraphQL when saved config requests it", () => {
  const actual = autoDetect.getMatchingAutoPattern("https://x.com/user/status/123", {
    auto_detect: {
      x_article: true,
      x_article_graphql: true,
    },
  })

  assert.equal(actual?.patternId, "x_article")
})

test("getMatchingAutoPattern returns null when DOM is disabled", () => {
  const actual = autoDetect.getMatchingAutoPattern("https://x.com/user/status/123", {
    auto_detect: {
      x_article: false,
      x_article_graphql: true,
    },
  })

  assert.equal(actual, null)
})

test("DOM X article extractor page script is valid JavaScript", async () => {
  const match = autoDetect.getMatchingAutoPattern("https://x.com/user/status/123", {})
  assert.ok(match)
  assert.equal(match.patternId, "x_article")

  const page: PageProxy = {
    url: "https://x.com/user/status/123",
    async evaluate(fn) {
      new Function(String(fn))
      return null
    },
    async installModule() {},
    async callModule() {},
    async screenshot() { return Buffer.alloc(0) },
    onNotify() {},
    async disposeCollector() {},
    onCleanup() {},
  }

  const actual = await match.extract(page)

  assert.equal(actual, null)
})

// ---------------------------------------------------------------------------
// Tests for new Defuddle-based extraction helpers
// ---------------------------------------------------------------------------

test("extractImageUrlsFromHtml extracts absolute image URLs from HTML", () => {
  const html = `
    <article>
      <p>Hello world</p>
      <img src="https://pbs.twimg.com/media/img1.jpg" alt="img1">
      <img src="https://example.com/photo.png" alt="photo">
      <img src="/relative/path.jpg" alt="relative">
    </article>
  `
  const actual = autoDetect.__test__?.extractImageUrlsFromHtml?.(html) ?? []

  assert.deepEqual(actual, [
    "https://pbs.twimg.com/media/img1.jpg",
    "https://example.com/photo.png",
  ])
})

test("extractImageUrlsFromHtml deduplicates URLs", () => {
  const html = `
    <img src="https://example.com/a.png">
    <img src="https://example.com/a.png">
    <img src="https://example.com/b.jpg">
  `
  const actual = autoDetect.__test__?.extractImageUrlsFromHtml?.(html) ?? []

  assert.deepEqual(actual, [
    "https://example.com/a.png",
    "https://example.com/b.jpg",
  ])
})

test("extractImageUrlsFromHtml returns empty array for no images", () => {
  const actual = autoDetect.__test__?.extractImageUrlsFromHtml?.("<p>No images here</p>") ?? []
  assert.deepEqual(actual, [])
})

test("runDefuddleOnHtml extracts title and content from well-formed HTML", async () => {
  const html = `<!DOCTYPE html><html><head><title>Test Article</title></head>
  <body><article><h1>My Title</h1><p>Paragraph one.</p><p>Paragraph two.</p></article></body></html>`

  const result = await autoDetect.__test__?.runDefuddleOnHtml?.(html, "https://example.com")

  assert.ok(result, "runDefuddleOnHtml should return a result")
  assert.ok(result.html.length > 0, "html should be non-empty")
  assert.ok(result.title === "Test Article" || result.title === "My Title", `title should be extracted, got: ${result.title}`)
})

test("runDefuddleOnHtml returns null for empty HTML", async () => {
  const result = await autoDetect.__test__?.runDefuddleOnHtml?.("", "https://example.com")
  // Defuddle may return empty content or throw — either way we handle gracefully
  assert.ok(result === null || result.html === "", "should return null or empty for empty input")
})
