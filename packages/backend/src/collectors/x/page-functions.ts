// @ts-nocheck
/**
 * Page-side functions for the X collector.
 *
 * These functions are serialized via .toString() and injected into the browser
 * page context via installModule(). They reference browser globals (window,
 * document, DOM types) that don't exist in Node.js — hence @ts-nocheck.
 *
 * In-page access: window.__latent.x.<functionName>(...)
 */

/* eslint-disable @typescript-eslint/no-unsafe-function-type */

/**
 * extractTweets — extract visible, unbadged tweets from the DOM.
 */
export function extractTweets(opts) {
  opts = opts || {}
  var includeBadgedNeedsScreenshot = !!opts.includeBadgedNeedsScreenshot
  var onlyNeedsScreenshot = !!opts.onlyNeedsScreenshot

  var vpH = window.innerHeight
  function visibleRatio(rect) {
    if (!rect || !rect.height) return 0
    var visibleTop = Math.max(rect.top, 0)
    var visibleBottom = Math.min(rect.bottom, vpH)
    var visibleH = Math.max(0, visibleBottom - visibleTop)
    return visibleH / Math.max(rect.height, 1)
  }
  function toCanonicalTweetUrl(rawUrl) {
    if (!rawUrl) return null
    try {
      var parsed = new URL(rawUrl, location.href)
      var match = parsed.pathname.match(/^\/([^/]+)\/status\/(\d+)/)
      if (!match) return null
      return parsed.origin + "/" + match[1] + "/status/" + match[2]
    } catch {
      return null
    }
  }

  function getTweetFiberData(articleEl) {
    try {
      var fiberKey = Object.keys(articleEl).find(function(k) {
        return k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance")
      })
      if (!fiberKey) return null
      var node = articleEl[fiberKey]
      for (var depth = 0; node && depth < 40; depth++) {
        try {
          var props = node.memoizedProps
          if (props && typeof props === "object") {
            for (var key in props) {
              var val = props[key]
              if (val && typeof val === "object" && !Array.isArray(val) &&
                  !(val instanceof HTMLElement) && val.id_str && val.full_text !== undefined) {
                return {
                  id_str: val.id_str || null,
                  in_reply_to_status_id_str: val.in_reply_to_status_id_str || null,
                  in_reply_to_screen_name: val.in_reply_to_screen_name || null,
                  quoted_status_id_str: val.quoted_status_id_str || null,
                }
              }
            }
          }
        } catch { /* skip */ }
        node = node.return
      }
    } catch { /* fiber walk failed */ }
    return null
  }

  return Array.from(document.querySelectorAll('article[data-testid="tweet"]'))
    .filter(function(el) {
      var badge = el.querySelector(".li-scrape-badge")
      if (badge) {
        if (!includeBadgedNeedsScreenshot) return false
        if (badge.getAttribute("data-latent-shot") === "1") return false
      } else if (onlyNeedsScreenshot) {
        return false
      }
      var link = el.querySelector('a[href*="/status/"]')
      if (!link) return false

      var hasImage = el.querySelector('div[data-testid="tweetPhoto"] img, a[href*="/photo/"] img')
      if (hasImage) {
        return visibleRatio(hasImage.getBoundingClientRect()) >= 0.25
      } else {
        var textEl = el.querySelector('[data-testid="tweetText"]')
        if (textEl) {
          return visibleRatio(textEl.getBoundingClientRect()) >= 0.25
        }
        return visibleRatio(el.getBoundingClientRect()) >= 0.4
      }
    })
    .map(function(el) {
      var timeEl = el.querySelector("time")
      var timeLink = timeEl && timeEl.closest ? timeEl.closest('a[href*="/status/"]') : null
      var fallbackLink = el.querySelector('a[href*="/status/"]')
      var canonicalUrl = toCanonicalTweetUrl(timeLink ? timeLink.href : null) ||
        toCanonicalTweetUrl(fallbackLink ? fallbackLink.href : null)
      if (!canonicalUrl) return null

      // Extract text with emoji support
      var text = ""
      var textEl = el.querySelector('[data-testid="tweetText"]')
      if (textEl) {
        var parts = []
        var walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, null, false)
        var node
        while ((node = walker.nextNode())) {
          if (node.nodeType === 3) {
            var t = node.textContent
            if (t) parts.push(t)
          } else if (node.nodeName === "IMG" && node.alt) {
            parts.push(node.alt)
          }
        }
        text = parts.join("").trim()
      }

      var timestamp = timeEl ? timeEl.getAttribute("datetime") : null
      var imageUrls = Array.from(
        el.querySelectorAll('div[data-testid="tweetPhoto"] img, a[href*="/photo/"] img')
      ).map(function(img) { return img.currentSrc || img.src }).filter(Boolean)

      // Content links (URLs in tweet body)
      var contentLinks = []
      if (textEl) {
        var anchors = textEl.querySelectorAll("a[href]")
        for (var a = 0; a < anchors.length; a++) {
          var href = anchors[a].href
          if (/^\/(hashtag|search)\b/.test(new URL(href, location.href).pathname)) continue
          if (/\/(x\.com|twitter\.com)\/[^/]+\/status\//.test(href)) continue
          var linkText = anchors[a].textContent.trim()
          if (href && linkText) {
            contentLinks.push({ url: href, text: linkText })
          }
        }
      }

      // Quoted tweet
      var quotedTweetUrl = null
      var quoteBlock = el.querySelector('[data-testid="quoteTweet"]')
      if (quoteBlock) {
        var qLink = quoteBlock.querySelector('a[href*="/status/"]')
        if (qLink) quotedTweetUrl = toCanonicalTweetUrl(qLink.href)
      }
      if (!quotedTweetUrl) {
        var innerLinks = el.querySelectorAll('a[href*="/status/"]')
        for (var q = 0; q < innerLinks.length; q++) {
          var qUrl = toCanonicalTweetUrl(innerLinks[q].href)
          if (!qUrl || qUrl === canonicalUrl) continue
          if (innerLinks[q].querySelector("time")) continue
          if (/\/(analytics|photo|video)/.test(innerLinks[q].href)) continue
          quotedTweetUrl = qUrl
          break
        }
      }
      if (quotedTweetUrl === canonicalUrl) quotedTweetUrl = null

      // Card link
      var cardLink = null
      var cardEl = el.querySelector('[data-testid="card.wrapper"] a[href]')
      if (cardEl) cardLink = cardEl.href

      // Profile info
      var avatarEl = el.querySelector('img[src*="profile_images"]')
      var avatarUrl = avatarEl ? avatarEl.src : ""
      var userNameEl = el.querySelector('[data-testid="User-Name"]')
      var displayName = ""
      var handle = ""
      if (userNameEl) {
        var spans = userNameEl.querySelectorAll("span")
        for (var s = 0; s < spans.length; s++) {
          var txt = spans[s].textContent.trim()
          if (txt.startsWith("@")) { handle = txt; break }
        }
        var firstLink = userNameEl.querySelector("a")
        if (firstLink) displayName = firstLink.textContent.trim()
      }

      // Parent tweet via React fiber
      var parentTweetUrl = null
      var fiberData = getTweetFiberData(el)
      if (fiberData && fiberData.in_reply_to_status_id_str) {
        var replyUser = fiberData.in_reply_to_screen_name
        var replyId = fiberData.in_reply_to_status_id_str
        if (replyUser && replyId) {
          parentTweetUrl = location.origin + "/" + replyUser + "/status/" + replyId
        }
      }

      // DOM-based parent fallback
      if (!parentTweetUrl) {
        var allStatusLinks = el.querySelectorAll('a[href*="/status/"]')
        var candidateParents = []
        for (var pi = 0; pi < allStatusLinks.length; pi++) {
          var pHref = allStatusLinks[pi].href
          if (allStatusLinks[pi].querySelector("time")) continue
          if (/\/(analytics|photo|video)/.test(pHref)) continue
          var pCanon = toCanonicalTweetUrl(pHref)
          if (pCanon && pCanon !== canonicalUrl && pCanon !== quotedTweetUrl) {
            candidateParents.push(pCanon)
          }
        }
        var tweetTextEl2 = el.querySelector('[data-testid="tweetText"]')
        if (tweetTextEl2 && candidateParents.length > 0) {
          var container = tweetTextEl2.parentElement
          if (container) {
            var prev = container.previousElementSibling
            while (prev) {
              var mentionLink = prev.querySelector('a[href^="/"][role="link"]')
              if (mentionLink) {
                var mentionHref = mentionLink.getAttribute("href")
                if (mentionHref && /^\/[^/]+$/.test(mentionHref)) {
                  parentTweetUrl = candidateParents[0]
                  break
                }
              }
              prev = prev.previousElementSibling
            }
          }
        }
      }

      return {
        url: canonicalUrl, text: text, timestamp: timestamp, imageUrls: imageUrls,
        contentLinks: contentLinks, quotedTweetUrl: quotedTweetUrl, cardLink: cardLink,
        parentTweetUrl: parentTweetUrl,
        avatarUrl: avatarUrl, displayName: displayName, handle: handle,
      }
    })
    .filter(Boolean)
}

/** Escape a string for safe use inside a CSS attribute selector. */
export function cssEscape(str) {
  return str.replace(/[\\"'\[\](){}|^$*+?.]/g, function(ch) { return "\\" + ch })
}

/**
 * addBadges — mark scraped tweets with visual badges.
 */
export function addBadges(items) {
  for (var i = 0; i < items.length; i++) {
    var item = items[i]
    var article = document.querySelector('article:has(a[href*="' + cssEscape(item.pathname) + '"])')
    if (!article) continue
    var badgeHost = article.querySelector('[data-testid="User-Name"]') || article
    var existing = article.querySelector(".li-scrape-badge")
    var badge = existing || document.createElement("span")
    badge.className = "li-scrape-badge"
    var timeStr = ""
    if (item.collectAt) {
      try { var d = new Date(item.collectAt); timeStr = " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) } catch(e) {}
    }
    badge.textContent = item.ymd + timeStr
    var hasScreenshot = item.hasScreenshot !== false
    var prevShot = badge.getAttribute("data-latent-shot")
    var bgColor = item.isExisting
      ? "background:rgba(229,168,38,0.18);color:#d6a130"
      : "background:rgba(38,222,176,0.18);color:#16a085"
    badge.style.cssText = "margin-left:8px;padding:2px 6px;border-radius:999px;font-size:11px;font-weight:600;letter-spacing:0.02em;" + bgColor
    if (!existing) {
      badgeHost.appendChild(badge)
    }
    if (hasScreenshot || prevShot === "1") {
      badge.setAttribute("data-latent-shot", "1")
    } else {
      badge.setAttribute("data-latent-shot", "0")
    }
  }
}

/**
 * getViewportState — returns current scroll/viewport info.
 */
export function getViewportState() {
  return {
    x: window.scrollX || window.pageXOffset || 0,
    y: window.scrollY || window.pageYOffset || 0,
    width: window.innerWidth || 0,
    height: window.innerHeight || 0,
    dpr: window.devicePixelRatio || 1,
  }
}

/**
 * waitForScrollIdle — wait until scroll motion settles.
 */
export function waitForScrollIdle(opts) {
  opts = opts || {}
  var idleMsRaw = Number(opts.idleMs)
  var timeoutMsRaw = Number(opts.timeoutMs)
  var idleMs = isFinite(idleMsRaw) ? Math.max(80, idleMsRaw) : 220
  var timeoutMs = isFinite(timeoutMsRaw) ? Math.max(idleMs + 80, timeoutMsRaw) : 2200
  return new Promise(function(resolve) {
    var startAt = performance.now()
    var lastMotionAt = startAt
    var startX = window.scrollX || window.pageXOffset || 0
    var startY = window.scrollY || window.pageYOffset || 0
    var lastX = startX
    var lastY = startY
    var done = false
    var rafId = 0
    function finish(idle) {
      if (done) return
      done = true
      window.removeEventListener("scroll", onScroll)
      if (rafId) window.cancelAnimationFrame(rafId)
      resolve({
        idle: !!idle,
        elapsedMs: Math.round(performance.now() - startAt),
        startX: startX, startY: startY,
        endX: window.scrollX || window.pageXOffset || 0,
        endY: window.scrollY || window.pageYOffset || 0,
      })
    }
    function onScroll() {
      lastX = window.scrollX || window.pageXOffset || 0
      lastY = window.scrollY || window.pageYOffset || 0
      lastMotionAt = performance.now()
    }
    function tick() {
      if (done) return
      var now = performance.now()
      var x = window.scrollX || window.pageXOffset || 0
      var y = window.scrollY || window.pageYOffset || 0
      if (x !== lastX || y !== lastY) {
        lastX = x; lastY = y; lastMotionAt = now
      }
      if (now - lastMotionAt >= idleMs) { finish(true); return }
      if (now - startAt >= timeoutMs) { finish(false); return }
      rafId = window.requestAnimationFrame(tick)
    }
    window.addEventListener("scroll", onScroll, { passive: true })
    rafId = window.requestAnimationFrame(tick)
  })
}

/**
 * getClipPlan — returns viewport-clamped rects for visible tweets.
 */
export function getClipPlan(input) {
  var opts = Array.isArray(input) ? { urls: input } : (input || { urls: [] })
  var urls = Array.isArray(opts.urls) ? opts.urls : []
  var strict = opts.strict !== false
  var edgeMargin = typeof opts.edgeMargin === "number" ? Math.max(0, opts.edgeMargin) : 24
  var minVisibleRatio = typeof opts.minVisibleRatio === "number"
    ? Math.max(0, Math.min(1, opts.minVisibleRatio)) : 0.92
  var vpW = window.innerWidth
  var vpH = window.innerHeight
  var stats = { requested: urls.length, accepted: 0, missing: 0, tooTall: 0, lowVisible: 0, edgeTouch: 0, tooSmall: 0 }
  var rects = urls.map(function(url) {
    var pathname = null
    try { pathname = new URL(url).pathname } catch { /* skip */ }
    if (!pathname) { stats.missing += 1; return null }
    var article = document.querySelector('article:has(a[href*="' + cssEscape(pathname) + '"])')
    if (!article) { stats.missing += 1; return null }
    var r = article.getBoundingClientRect()
    var visibleTop = Math.max(r.top, 0)
    var visibleBottom = Math.min(r.bottom, vpH)
    var visibleH = Math.max(0, visibleBottom - visibleTop)
    var vRatio = visibleH / Math.max(r.height, 1)
    var tooTallForViewport = r.height > Math.max(40, vpH - edgeMargin * 2)
    if (strict) {
      if (tooTallForViewport) { stats.tooTall += 1; return null }
      if (vRatio < minVisibleRatio) { stats.lowVisible += 1; return null }
      if (r.top < edgeMargin || r.bottom > vpH - edgeMargin) { stats.edgeTouch += 1; return null }
    }
    var left = Math.max(0, Math.floor(r.left))
    var top = Math.max(0, Math.floor(r.top))
    var right = Math.min(vpW, Math.ceil(r.right))
    var bottom = Math.min(vpH, Math.ceil(r.bottom))
    var w = right - left
    var h = bottom - top
    if (w < 80 || h < 40) { stats.tooSmall += 1; return null }
    stats.accepted += 1
    return { x: left, y: top, width: w, height: h }
  })
  return {
    rects: rects,
    stats: stats,
    viewport: { width: vpW, height: vpH },
    scroll: { x: window.scrollX || window.pageXOffset || 0, y: window.scrollY || window.pageYOffset || 0 },
  }
}

/**
 * cropScreenshot — crop a full-viewport base64 screenshot into per-tweet images.
 */
export function cropScreenshot(opts) {
  var fullBase64 = opts.fullBase64
  var clips = opts.clips
  var outputFormat = opts.outputFormat === "image/jpeg" ? "image/jpeg" : "image/png"
  var outputQuality = typeof opts.outputQuality === "number" ? Math.max(0.2, Math.min(1, opts.outputQuality)) : 0.82
  return new Promise(function(resolve) {
    var img = new Image()
    img.onload = function() {
      var dpr = window.devicePixelRatio || 1
      var results = []
      for (var i = 0; i < clips.length; i++) {
        var clip = clips[i]
        if (!clip) { results.push(null); continue }
        try {
          var canvas = document.createElement("canvas")
          var cw = Math.ceil(clip.width * dpr)
          var ch = Math.ceil(clip.height * dpr)
          canvas.width = cw
          canvas.height = ch
          var ctx = canvas.getContext("2d")
          ctx.drawImage(img,
            Math.floor(clip.x * dpr), Math.floor(clip.y * dpr), cw, ch,
            0, 0, cw, ch
          )
          results.push(canvas.toDataURL(outputFormat, outputQuality))
        } catch (e) {
          results.push(null)
        }
      }
      resolve(results)
    }
    img.onerror = function() {
      resolve(clips.map(function() { return null }))
    }
    img.src = fullBase64
  })
}

/**
 * startWatching — set up MutationObserver + scroll listener to detect new tweets.
 */
export function startWatching(opts) {
  if (window[opts.watchingFlag]) return
  window[opts.watchingFlag] = true
  var modName = opts.appName
  var notifyKey = opts.notifyKey
  var notifyTimer = null
  var notifyDueAt = 0
  var pendingReason = "unknown"
  var pendingDetectedAt = 0
  var lastNotifyAt = 0
  var lastScrollCheck = 0
  var scrollIdleTimer = null
  var lastScrollY = window.scrollY || window.pageYOffset || 0
  var THROTTLE_MS = 120
  var MIN_NOTIFY_COOLDOWN_MS = 120
  var SCROLL_SETTLE_DOWN_MS = 120
  var SCROLL_SETTLE_UP_MS = 60
  var SCROLL_IDLE_MS = 360
  var EMPTY_RETRY_MS = 120
  var EMPTY_RETRIES = 4

  function isEnabled() {
    return !(window.__latent && window.__latent[modName] && window.__latent[modName].enabled === false)
  }

  function countVisibleUnbadgedTweets() {
    var vpH = window.innerHeight
    function visRatio(rect) {
      if (!rect || !rect.height) return 0
      var visTop = Math.max(rect.top, 0)
      var visBot = Math.min(rect.bottom, vpH)
      return Math.max(0, visBot - visTop) / Math.max(rect.height, 1)
    }
    var articles = document.querySelectorAll('article[data-testid="tweet"]')
    var count = 0
    for (var i = 0; i < articles.length; i++) {
      var el = articles[i]
      var badge = el.querySelector(".li-scrape-badge")
      if (badge && badge.getAttribute("data-latent-shot") === "1") continue
      if (!el.querySelector('a[href*="/status/"]')) continue
      var hasImage = el.querySelector('div[data-testid="tweetPhoto"] img, a[href*="/photo/"] img')
      if (hasImage) {
        if (visRatio(hasImage.getBoundingClientRect()) >= 0.25) count++
      } else {
        var textEl = el.querySelector('[data-testid="tweetText"]')
        if (textEl) {
          if (visRatio(textEl.getBoundingClientRect()) >= 0.25) count++
        } else {
          if (visRatio(el.getBoundingClientRect()) >= 0.4) count++
        }
      }
    }
    return count
  }

  function armNotify(dueAt) {
    var delay = Math.max(0, dueAt - Date.now())
    if (notifyTimer) clearTimeout(notifyTimer)
    notifyDueAt = dueAt
    notifyTimer = setTimeout(function() {
      notifyTimer = null
      notifyDueAt = 0
      fireNotify(0)
    }, delay)
  }

  function fireNotify(attempt) {
    if (!isEnabled()) return
    var visibleCount = countVisibleUnbadgedTweets()
    if (visibleCount <= 0) {
      if (attempt < EMPTY_RETRIES) {
        notifyTimer = setTimeout(function() {
          notifyTimer = null
          fireNotify(attempt + 1)
        }, EMPTY_RETRY_MS)
      } else {
        pendingReason = "unknown"
        pendingDetectedAt = 0
      }
      return
    }
    var now = Date.now()
    lastNotifyAt = now
    __latentInfoNotify(JSON.stringify({
      key: notifyKey,
      reason: pendingReason || "unknown",
      visibleCount: visibleCount,
      detectedAt: pendingDetectedAt || now,
    }))
    pendingReason = "unknown"
    pendingDetectedAt = 0
  }

  function scheduleNotify(reason, mode, direction) {
    if (!isEnabled()) return
    var now = Date.now()
    pendingDetectedAt = now
    pendingReason = reason || pendingReason || "unknown"
    var baseDelay = 0
    if (mode === "scroll") {
      baseDelay = direction === "up" ? SCROLL_SETTLE_UP_MS : SCROLL_SETTLE_DOWN_MS
    }
    var dueAt = Math.max(now + baseDelay, lastNotifyAt + MIN_NOTIFY_COOLDOWN_MS)
    if (mode === "scroll") {
      if (notifyTimer) return
      armNotify(dueAt)
      return
    }
    if (!notifyTimer || dueAt < notifyDueAt - 20) {
      armNotify(dueAt)
    }
  }

  // Use ResourceTracker if available for cleanable resource registration
  var tracker = window.__latent && window.__latent.__tracker
  var cid = opts.collectorId || "x"

  var scrollHandler = function() {
    var now = Date.now()
    if (now - lastScrollCheck < THROTTLE_MS) return
    lastScrollCheck = now
    var y = window.scrollY || window.pageYOffset || 0
    var direction = y < lastScrollY ? "up" : (y > lastScrollY ? "down" : "flat")
    lastScrollY = y
    var reason = direction === "up" ? "scroll_up" : "scroll"
    scheduleNotify(reason, "scroll", direction)
    if (scrollIdleTimer) clearTimeout(scrollIdleTimer)
    scrollIdleTimer = setTimeout(function() {
      scrollIdleTimer = null
      scheduleNotify("scroll_idle", "mutation", "flat")
    }, SCROLL_IDLE_MS)
  }

  if (tracker) {
    tracker.addListener(cid, window, "scroll", scrollHandler, { passive: true })
  } else {
    window.addEventListener("scroll", scrollHandler, { passive: true })
  }

  var observer = new MutationObserver(function(mutations) {
    var hasTweet = false
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i]
      for (var j = 0; j < m.addedNodes.length; j++) {
        var node = m.addedNodes[j]
        if (node.nodeType === 1 && node.querySelector &&
            (node.matches('article[data-testid="tweet"]') ||
             node.querySelector('article[data-testid="tweet"]'))) {
          hasTweet = true
          break
        }
      }
      if (hasTweet) break
    }
    if (hasTweet) scheduleNotify("mutation", "mutation", "flat")
  })

  if (tracker) {
    tracker.addObserver(cid, observer, document.body, { childList: true, subtree: true })
    tracker.addCleanup(cid, function() { window[opts.watchingFlag] = false })
  } else {
    observer.observe(document.body, { childList: true, subtree: true })
  }
}
