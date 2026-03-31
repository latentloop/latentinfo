/**
 * Auto-detect patterns for the web_clipper collector.
 *
 * Each pattern has a URL match condition and page-side extraction logic.
 * Patterns are independently toggleable via collector config.
 */

import type { PageProxy } from "../../collector-runner.js"
import type { CollectorSettings } from "../../collector-config.js"
import { loadCollectorConfig } from "../../collector-config.js"
import { createLogger } from "../../logger.js"
import { getArticle } from "../../storage/article-db.js"
import { storeClip, computeSourceKey } from "./store-clip.js"

const log = createLogger("web-clipper-autodetect")

// Polyfill globalThis.Node for defuddle's TwitterExtractor which references
// Node.DOCUMENT_POSITION_FOLLOWING — a browser DOM constant missing in Node.js.
if (typeof (globalThis as Record<string, unknown>).Node === "undefined") {
  (globalThis as Record<string, unknown>).Node = {
    ELEMENT_NODE: 1, ATTRIBUTE_NODE: 2, TEXT_NODE: 3,
    CDATA_SECTION_NODE: 4, PROCESSING_INSTRUCTION_NODE: 7,
    COMMENT_NODE: 8, DOCUMENT_NODE: 9, DOCUMENT_TYPE_NODE: 10,
    DOCUMENT_FRAGMENT_NODE: 11,
    DOCUMENT_POSITION_DISCONNECTED: 0x01, DOCUMENT_POSITION_PRECEDING: 0x02,
    DOCUMENT_POSITION_FOLLOWING: 0x04, DOCUMENT_POSITION_CONTAINS: 0x08,
    DOCUMENT_POSITION_CONTAINED_BY: 0x10, DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC: 0x20,
  }
}

/**
 * Run Defuddle on raw HTML server-side (Node.js) to extract clean content.
 * Returns cleaned HTML, markdown, title, author, and description.
 */
async function runDefuddleOnHtml(rawHtml: string, sourceUrl: string): Promise<{
  html: string
  markdown: string
  title: string
  author: string
  description: string
} | null> {
  try {
    const { Defuddle } = await import("defuddle/node")
    const result = await Defuddle(rawHtml, sourceUrl, { separateMarkdown: true })
    return {
      html: result.content ?? "",
      markdown: result.contentMarkdown ?? result.content?.replace(/<[^>]+>/g, "").trim() ?? "",
      title: result.title ?? "",
      author: result.author ?? "",
      description: result.description ?? "",
    }
  } catch (e: unknown) {
    log.warn(`Defuddle extraction failed: ${e instanceof Error ? e.message : e}`)
    return null
  }
}

/** Extract absolute image URLs from cleaned HTML. */
function extractImageUrlsFromHtml(html: string): string[] {
  const urls: string[] = []
  const seen = new Set<string>()
  const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi
  let match: RegExpExecArray | null
  while ((match = imgRegex.exec(html)) !== null) {
    const src = match[1]!
    if (src && !seen.has(src) && src.startsWith("http")) {
      seen.add(src)
      urls.push(src)
    }
  }
  return urls
}

export interface AutoDetectResult {
  html: string
  title: string
  url: string
  imageUrls?: string[]
  /** Author name or handle extracted from page metadata. */
  author?: string
  /** Page description or excerpt. */
  description?: string
  /** Tweet author avatar URL (X/Twitter only). */
  avatarUrl?: string
  /** Tweet author display name (X/Twitter only). */
  displayName?: string
  /** Tweet author handle without @ (X/Twitter only). */
  handle?: string
  /** Tweet datetime ISO string from <time> element (X/Twitter only). */
  tweetDate?: string
}

/** Runtime validation for page.evaluate() results (returns unknown). */
function isAutoDetectResult(value: unknown): value is AutoDetectResult {
  if (value == null || typeof value !== "object") return false
  const obj = value as Record<string, unknown>
  return typeof obj.html === "string" && obj.html !== ""
    && typeof obj.title === "string"
    && typeof obj.url === "string"
    && (obj.imageUrls === undefined
      || (Array.isArray(obj.imageUrls) && obj.imageUrls.every((entry) => typeof entry === "string")))
}

export function extractGraphqlImageUrls(
  entityMap: Record<string, unknown>,
  entityRanges?: Array<{ key?: string | number }>,
): string[] {
  const urls: string[] = []
  const seen = new Set<string>()

  function maybeAdd(value: unknown) {
    if (typeof value !== "string") return
    if (!/^https?:\/\//i.test(value)) return
    const lower = value.toLowerCase()
    const looksLikeImage = lower.includes("pbs.twimg.com/media/")
      || lower.includes("twimg.com/media/")
      || /\.(png|jpe?g|gif|webp)(?:\?|$)/i.test(lower)
      || /[?&]format=(png|jpe?g|gif|webp)(?:&|$)/i.test(lower)
    if (!looksLikeImage || seen.has(value)) return
    seen.add(value)
    urls.push(value)
  }

  function walk(value: unknown) {
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (value && typeof value === "object") {
      for (const nested of Object.values(value as Record<string, unknown>)) walk(nested)
      return
    }
    maybeAdd(value)
  }

  const keys = (entityRanges ?? [])
    .map((range) => range.key)
    .filter((key): key is string | number => key !== undefined && key !== null)

  if (keys.length === 0) {
    walk(entityMap)
    return urls
  }

  for (const key of keys) {
    const entity = entityMap[String(key)]
    if (entity !== undefined) walk(entity)
  }

  return urls
}

interface AutoDetectPattern {
  /** URL match check (runs in Node) */
  matchesUrl: (url: string) => boolean
  /** Extract content from the page (runs page-side via evaluate) */
  extract: (page: PageProxy) => Promise<AutoDetectResult | null>
}

// ---------------------------------------------------------------------------
// Built-in patterns
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// GraphQL-based article detection + extraction (Unit 1)
// ---------------------------------------------------------------------------

const GRAPHQL_FALLBACK_QUERY_ID = "7xflPyRiUxGVbJd4uWmbfg"

const xArticleGraphqlPattern: AutoDetectPattern = {
  matchesUrl(url: string) {
    return /^https?:\/\/(x\.com|twitter\.com)\/[^/]+\/status\//.test(url)
  },

  async extract(page: PageProxy): Promise<AutoDetectResult | null> {
    // Wait briefly for page cookies to be available
    await new Promise<void>((resolve) => setTimeout(resolve, 2000))

    const result = await page.evaluate(`(async function() {
      try {
        // 1. Extract ct0 CSRF cookie
        var ct0 = (document.cookie.split(';').map(function(c){return c.trim()}).find(function(c){return c.startsWith('ct0=')}) || '').split('=')[1];
        if (!ct0) return null;

        // 2. Extract tweet ID from URL
        var m = location.href.match(/\\/status\\/(\\d+)/);
        if (!m) return null;
        var tweetId = m[1];

        // 3. Resolve queryId
        var queryId = null;
        try {
          var ghResp = await fetch('https://raw.githubusercontent.com/fa0311/twitter-openapi/refs/heads/main/src/config/placeholder.json');
          if (ghResp.ok) {
            var ghData = await ghResp.json();
            var entry = ghData && ghData['TweetResultByRestId'];
            if (entry && entry.queryId) queryId = entry.queryId;
          }
        } catch(e) {}
        if (!queryId) {
          try {
            var scripts = performance.getEntriesByType('resource')
              .filter(function(r){return r.name.includes('client-web') && r.name.endsWith('.js')})
              .map(function(r){return r.name});
            for (var si = 0; si < Math.min(scripts.length, 15); si++) {
              try {
                var text = await (await fetch(scripts[si])).text();
                var re = /queryId:"([A-Za-z0-9_-]+)"[^}]{0,200}operationName:"TweetResultByRestId"/;
                var qm = text.match(re);
                if (qm) { queryId = qm[1]; break; }
              } catch(e) {}
            }
          } catch(e) {}
        }
        if (!queryId) queryId = ${JSON.stringify(GRAPHQL_FALLBACK_QUERY_ID)};

        // 4. Fetch GraphQL
        var bearer = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
        var headers = {
          'Authorization': 'Bearer ' + decodeURIComponent(bearer),
          'X-Csrf-Token': ct0,
          'X-Twitter-Auth-Type': 'OAuth2Session',
          'X-Twitter-Active-User': 'yes'
        };
        var variables = JSON.stringify({
          tweetId: tweetId,
          withCommunity: false,
          includePromotedContent: false,
          withVoice: false
        });
        var features = JSON.stringify({
          longform_notetweets_consumption_enabled: true,
          responsive_web_twitter_article_tweet_consumption_enabled: true,
          longform_notetweets_rich_text_read_enabled: true,
          longform_notetweets_inline_media_enabled: true,
          articles_preview_enabled: true,
          responsive_web_graphql_exclude_directive_enabled: true,
          verified_phone_label_enabled: false
        });
        var fieldToggles = JSON.stringify({
          withArticleRichContentState: true,
          withArticlePlainText: true
        });
        var apiUrl = '/i/api/graphql/' + queryId + '/TweetResultByRestId?variables='
          + encodeURIComponent(variables)
          + '&features=' + encodeURIComponent(features)
          + '&fieldToggles=' + encodeURIComponent(fieldToggles);

        var resp = await fetch(apiUrl, { headers: headers, credentials: 'include' });
        if (!resp.ok) return null;
        var d = await resp.json();

        // 5. Parse response
        var result = d.data && d.data.tweetResult && d.data.tweetResult.result;
        if (!result) return null;
        var tw = result.tweet || result;
        var legacy = tw.legacy || {};
        var user = tw.core && tw.core.user_results && tw.core.user_results.result;
        var screenName = (user && user.legacy && user.legacy.screen_name) || 'unknown';

        // 6. Detection: check for article content
        var articleResults = tw.article && tw.article.article_results && tw.article.article_results.result;
        if (!articleResults) return null; // Not an X Article

        // 7. Extract article: convert Draft.js blocks to HTML
        var title = articleResults.title || '(Untitled)';
        var contentState = articleResults.content_state || {};
        var blocks = contentState.blocks || [];
        var entityMap = contentState.entityMap || {};
        var __name = function(fn) { return fn; };
        var extractGraphqlImageUrls = ${extractGraphqlImageUrls.toString()};

        if (blocks.length === 0) return null;

        function escapeHtml(s) {
          return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        }

        function isHttpUrl(url) {
          return /^https?:\\/\\//i.test(url);
        }

        // Apply both inline styles and entity ranges in a single right-to-left pass
        // to avoid offset corruption from earlier insertions.
        function applyAnnotations(rawText, inlineStyleRanges, entityRanges, entityMap) {
          var text = escapeHtml(rawText);
          // Merge style and entity ranges into a single list, sorted by offset descending
          var ops = [];
          if (inlineStyleRanges) {
            for (var i = 0; i < inlineStyleRanges.length; i++) {
              var sr = inlineStyleRanges[i];
              ops.push({ offset: sr.offset, length: sr.length, kind: 'style', style: sr.style });
            }
          }
          if (entityRanges) {
            for (var i = 0; i < entityRanges.length; i++) {
              var er = entityRanges[i];
              var entity = entityMap[er.key];
              if (entity) ops.push({ offset: er.offset, length: er.length, kind: 'entity', entity: entity });
            }
          }
          // Sort descending by offset so right-to-left application preserves earlier indices
          ops.sort(function(a,b){ return b.offset - a.offset || b.length - a.length; });
          for (var i = 0; i < ops.length; i++) {
            var op = ops[i];
            var start = op.offset;
            var end = op.offset + op.length;
            var fragment = text.substring(start, end);
            if (op.kind === 'style') {
              if (op.style === 'BOLD') fragment = '<strong>' + fragment + '</strong>';
              else if (op.style === 'ITALIC') fragment = '<em>' + fragment + '</em>';
            } else if (op.kind === 'entity') {
              if (op.entity.type === 'LINK' && op.entity.data && op.entity.data.url && isHttpUrl(op.entity.data.url)) {
                fragment = '<a href="' + escapeHtml(op.entity.data.url) + '">' + fragment + '</a>';
              }
            }
            text = text.substring(0, start) + fragment + text.substring(end);
          }
          return text;
        }

        var htmlParts = [];
        var listBuffer = [];
        var listType = null;
        var imageUrls = [];
        var imageSeen = {};

        function flushList() {
          if (listBuffer.length > 0) {
            var tag = listType === 'ordered' ? 'ol' : 'ul';
            htmlParts.push('<' + tag + '>' + listBuffer.join('') + '</' + tag + '>');
            listBuffer = [];
            listType = null;
          }
        }

        for (var bi = 0; bi < blocks.length; bi++) {
          var block = blocks[bi];
          var blockType = block.type || 'unstyled';
          var rawText = block.text || '';
          if (blockType === 'atomic') {
            flushList();
            var atomicImageUrls = extractGraphqlImageUrls(entityMap, block.entityRanges || []);
            for (var ai = 0; ai < atomicImageUrls.length; ai++) {
              var atomicUrl = atomicImageUrls[ai];
              if (imageSeen[atomicUrl]) continue;
              imageSeen[atomicUrl] = true;
              imageUrls.push(atomicUrl);
              htmlParts.push('<figure><img src="' + escapeHtml(atomicUrl) + '" alt=""></figure>');
            }
            continue;
          }
          if (!rawText.trim() && blockType === 'unstyled') { flushList(); continue; }

          // Apply HTML escaping + inline styles + entities in one pass
          var text = applyAnnotations(rawText, block.inlineStyleRanges, block.entityRanges, entityMap);

          var isListItem = (blockType === 'unordered-list-item' || blockType === 'ordered-list-item');
          if (!isListItem) flushList();

          if (blockType === 'header-one') htmlParts.push('<h1>' + text + '</h1>');
          else if (blockType === 'header-two') htmlParts.push('<h2>' + text + '</h2>');
          else if (blockType === 'header-three') htmlParts.push('<h3>' + text + '</h3>');
          else if (blockType === 'blockquote') htmlParts.push('<blockquote><p>' + text + '</p></blockquote>');
          else if (blockType === 'code-block') htmlParts.push('<pre><code>' + text + '</code></pre>');
          else if (blockType === 'unordered-list-item') {
            listType = listType || 'unordered';
            listBuffer.push('<li>' + text + '</li>');
          }
          else if (blockType === 'ordered-list-item') {
            listType = listType || 'ordered';
            listBuffer.push('<li>' + text + '</li>');
          }
          else htmlParts.push('<p>' + text + '</p>');
        }
        flushList();

        var html = '<article>' + htmlParts.join('\\n') + '</article>';
        return {
          html: html,
          title: title,
          url: 'https://x.com/' + screenName + '/status/' + tweetId,
          imageUrls: imageUrls
        };
      } catch(e) {
        return null;
      }
    })()`)

    return isAutoDetectResult(result) ? result : null
  },
}

// ---------------------------------------------------------------------------
// DOM-based article detection + Defuddle server-side extraction
//
// Phase 1 (page-side): Poll for article container presence + content stabilization.
//   Waits for the article to fully render before grabbing the DOM.
// Phase 2 (server-side): Run Defuddle on the full page HTML to extract clean
//   semantic content, title, author, and image URLs.
// ---------------------------------------------------------------------------

const xArticlePattern: AutoDetectPattern = {
  matchesUrl(url: string) {
    return /^https?:\/\/(x\.com|twitter\.com)\/[^/]+\/status\//.test(url)
  },

  async extract(page: PageProxy): Promise<AutoDetectResult | null> {
    // Phase 1: Wait for article content to appear and stabilize in the DOM.
    // This fixes the race condition where content is captured before the SPA
    // finishes rendering.
    const detected = await page.evaluate(`(async function() {
      var POLL_INTERVAL = 500;
      var POLL_TIMEOUT = 15000;
      var MIN_CONTENT_LENGTH = 500;
      var STABILIZE_INTERVAL = 1000;
      var STABILIZE_ROUNDS = 3;
      var elapsed = 0;

      // Phase 1a: Poll until article container is present with enough content
      while (elapsed < POLL_TIMEOUT) {
        var container = document.querySelector('[data-testid="twitterArticleRichTextView"]')
          || document.querySelector('[data-testid="longformRichTextComponent"]');

        if (container && container.innerHTML && container.innerHTML.length > MIN_CONTENT_LENGTH) {
          var blockEls = container.querySelectorAll('p, div, h1, h2, h3, h4, h5, h6, blockquote, pre, ul, ol');
          if (blockEls.length >= 3) break;
        }
        await new Promise(function(resolve) { setTimeout(resolve, POLL_INTERVAL); });
        elapsed += POLL_INTERVAL;
      }

      // Phase 1b: Content stabilization — wait until content length stops growing.
      // This prevents capturing partial renders of long articles.
      var lastLength = 0;
      for (var round = 0; round < STABILIZE_ROUNDS; round++) {
        var c = document.querySelector('[data-testid="twitterArticleRichTextView"]')
          || document.querySelector('[data-testid="longformRichTextComponent"]')
          || document.querySelector('[data-testid="twitterArticleReadView"]');
        var currentLength = c ? c.innerHTML.length : 0;
        if (currentLength > 0 && currentLength === lastLength) break;
        lastLength = currentLength;
        await new Promise(function(resolve) { setTimeout(resolve, STABILIZE_INTERVAL); });
      }

      // Phase 1c: Check if we have content at all
      var finalContainer = document.querySelector('[data-testid="twitterArticleRichTextView"]')
        || document.querySelector('[data-testid="longformRichTextComponent"]')
        || document.querySelector('[data-testid="twitterArticleReadView"]');
      if (!finalContainer || !finalContainer.innerHTML || finalContainer.innerHTML.length < 200) {
        return null;
      }

      // Return the full page HTML for server-side Defuddle processing,
      // plus the page URL and a quick title extraction as fallback.
      var titleEl = document.querySelector('[data-testid="twitter-article-title"]');
      var domTitle = titleEl ? (titleEl.textContent || "").trim() : "";
      // Also extract author handle from the page
      var handleEl = document.querySelector('[data-testid="User-Name"] a[role="link"][href*="/"]');
      var handle = "";
      if (handleEl) {
        var href = handleEl.getAttribute('href') || '';
        if (href.charAt(0) === '/') href = href.slice(1);
        handle = href.split('/')[0] || '';
      }
      // Extract display name
      var nameEl = document.querySelector('[data-testid="User-Name"] span');
      var displayName = nameEl ? (nameEl.textContent || "").trim() : "";
      // Extract avatar URL
      var avatarEl = document.querySelector('[data-testid="Tweet-User-Avatar"] img');
      var avatarUrl = avatarEl ? (avatarEl.currentSrc || avatarEl.src || "") : "";
      // Extract tweet datetime
      var timeEl = document.querySelector('article[data-testid="tweet"] time');
      var tweetDate = timeEl ? (timeEl.getAttribute("datetime") || "") : "";
      // Extract hero image URL (first tweetPhoto in the article card)
      var heroImgEl = document.querySelector('div[data-testid="tweetPhoto"] img');
      var heroImageUrl = heroImgEl ? (heroImgEl.currentSrc || heroImgEl.src || "") : "";

      return {
        fullHtml: document.documentElement.outerHTML,
        domTitle: domTitle,
        handle: handle,
        displayName: displayName,
        avatarUrl: avatarUrl,
        tweetDate: tweetDate,
        heroImageUrl: heroImageUrl,
        url: location.href,
        contentLength: finalContainer.innerHTML.length
      };
    })()`) as {
      fullHtml: string
      domTitle: string
      handle: string
      displayName: string
      avatarUrl: string
      tweetDate: string
      heroImageUrl: string
      url: string
      contentLength: number
    } | null

    if (!detected) return null

    log.info({ url: detected.url, contentLength: detected.contentLength }, "Article detected, running Defuddle extraction")

    // Phase 2: Run Defuddle server-side on the full page HTML.
    const defuddled = await runDefuddleOnHtml(detected.fullHtml, detected.url)

    if (!defuddled || !defuddled.html || defuddled.html.length < 100) {
      // Defuddle failed or returned too little — fall back to DOM title + raw container
      log.warn({ url: detected.url }, "Defuddle returned insufficient content, falling back to DOM container")
      // Fall back to getting container innerHTML directly
      const fallbackHtml = await page.evaluate(`(function() {
        var c = document.querySelector('[data-testid="twitterArticleRichTextView"]')
          || document.querySelector('[data-testid="longformRichTextComponent"]')
          || document.querySelector('[data-testid="twitterArticleReadView"]');
        return c ? c.innerHTML : '';
      })()`) as string
      if (!fallbackHtml) return null
      const fallbackImageUrls: string[] = []
      if (detected.heroImageUrl) fallbackImageUrls.push(detected.heroImageUrl)
      return {
        html: fallbackHtml,
        title: detected.domTitle || "(Article)",
        url: detected.url,
        imageUrls: fallbackImageUrls.length > 0 ? fallbackImageUrls : undefined,
        author: detected.displayName || detected.handle || undefined,
        avatarUrl: detected.avatarUrl || undefined,
        displayName: detected.displayName || undefined,
        handle: detected.handle || undefined,
        tweetDate: detected.tweetDate || undefined,
      }
    }

    // Extract image URLs from Defuddle's cleaned HTML
    const imageUrls = extractImageUrlsFromHtml(defuddled.html)

    // Prepend hero image so it becomes media_data[0] (shown as banner in reader)
    if (detected.heroImageUrl) {
      const seen = new Set(imageUrls)
      if (!seen.has(detected.heroImageUrl)) {
        imageUrls.unshift(detected.heroImageUrl)
      }
    }

    const title = defuddled.title || detected.domTitle || "(Article)"
    const author = defuddled.author || detected.displayName || detected.handle || undefined

    log.info({
      url: detected.url,
      title,
      author,
      htmlLength: defuddled.html.length,
      images: imageUrls.length,
      heroImage: detected.heroImageUrl || "(none)",
    }, "Defuddle extraction complete")

    return {
      html: defuddled.html,
      title,
      url: detected.url,
      imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
      author,
      description: defuddled.description || undefined,
      avatarUrl: detected.avatarUrl || undefined,
      displayName: detected.displayName || undefined,
      handle: detected.handle || undefined,
      tweetDate: detected.tweetDate || undefined,
    }
  },
}

/** Registry of all built-in auto-detect patterns.
 *  Order matters — first match wins in createPageHandler. */
const patterns: Record<string, AutoDetectPattern> = {
  x_article: xArticlePattern,
  // temporarily comment out
  // x_article_graphql: xArticleGraphqlPattern,
}

function getEffectiveAutoDetectConfig(config: CollectorSettings): Record<string, boolean> {
  const autoDetect = config.auto_detect ?? {}
  return {
    x_article: autoDetect.x_article === true,
    x_article_graphql: false,
  }
}

// ---------------------------------------------------------------------------
// Public helper — check if a URL has a matching enabled auto-detect pattern
// ---------------------------------------------------------------------------

/**
 * Return the first auto-detect pattern whose URL matcher hits `url`,
 * ignoring the config toggle — used to show the auto-clip button
 * regardless of whether auto-triggering is enabled.
 */
export function getPatternForUrl(
  url: string,
): { patternId: string; extract: (page: PageProxy) => Promise<AutoDetectResult | null> } | null {
  for (const [patternId, pattern] of Object.entries(patterns)) {
    if (!pattern.matchesUrl(url)) continue
    return { patternId, extract: pattern.extract.bind(pattern) }
  }
  return null
}

/**
 * Return the first enabled auto-detect pattern whose URL matcher hits `url`,
 * or `null` if none match. Used by createPageHandler for auto-triggering clips.
 */
export function getMatchingAutoPattern(
  url: string,
  config: CollectorSettings,
): { patternId: string; extract: (page: PageProxy) => Promise<AutoDetectResult | null> } | null {
  const autoDetect = getEffectiveAutoDetectConfig(config)
  for (const [patternId, pattern] of Object.entries(patterns)) {
    if (autoDetect[patternId] === false) continue
    if (!pattern.matchesUrl(url)) continue
    return { patternId, extract: pattern.extract.bind(pattern) }
  }
  return null
}

// ---------------------------------------------------------------------------
// Page handler
// ---------------------------------------------------------------------------

/**
 * Create the pageHandler for the web_clipper collector.
 * Runs auto-detect patterns against the current page.
 */
export function createPageHandler(page: PageProxy): void {
  void (async () => {
    try {
      const config = loadCollectorConfig("web_clip")
      const autoDetect = getEffectiveAutoDetectConfig(config)

      const url = page.url

      for (const [patternId, pattern] of Object.entries(patterns)) {
        // Skip disabled patterns
        if (autoDetect[patternId] === false) continue

        // Check URL match
        if (!pattern.matchesUrl(url)) continue

        // Try extraction (each pattern handles its own timing internally)
        const result = await pattern.extract(page)
        if (!result) continue

        // Skip if a clip for this URL already exists (any version).
        const sourceKey = computeSourceKey(result.url, patternId)
        const existing = await getArticle(sourceKey)
        if (existing) {
          log.info({ pattern: patternId, url: result.url, sourceKey }, "Clip already exists — skipping auto-detect")
          break
        }

        log.info({ pattern: patternId, url: result.url, title: result.title }, "Auto-detected content")

        await storeClip({
          html: result.html,
          url: result.url,
          title: result.title,
          imageUrls: result.imageUrls,
          patternId,
          handle: result.handle || result.author,
          displayName: result.displayName,
          avatarUrl: result.avatarUrl,
          tweetDate: result.tweetDate,
        })

        // First match wins — don't run more patterns on the same page
        break
      }
    } catch (e: unknown) {
      // Don't log stale session errors (tab closed during detection)
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.includes("-32001") && !msg.includes("Session with given id not found")) {
        log.error(`Auto-detect error: ${msg}`)
      }
    }
  })()
}

export const __test__ = {
  extractGraphqlImageUrls,
  getEffectiveAutoDetectConfig,
  extractImageUrlsFromHtml,
  runDefuddleOnHtml,
}
