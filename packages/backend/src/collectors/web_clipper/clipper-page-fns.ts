// @ts-nocheck
/**
 * Page-side functions for the web clipper collector.
 *
 * These functions are serialized via .toString() and injected into the browser
 * page context via installModule(). They reference browser globals (window,
 * document, DOM types) that don't exist in Node.js — hence @ts-nocheck.
 *
 * In-page access: window.__latent.web_clipper.<functionName>(...)
 */

/* eslint-disable @typescript-eslint/no-unsafe-function-type */

// NOTE: No module-level variables! Functions serialized via .toString() cannot
// reference closure variables — all constants must be inlined in each function.

/**
 * initClipMode — enter element selection mode.
 *
 * Creates a highlight overlay (position:absolute with scroll offsets),
 * an adjust panel with navigation/confirm/cancel buttons, keyboard
 * handlers, and mousemove/click listeners. State tracked via
 * window.__latentClipState.
 */
export function initClipMode() {
  // Bail if already in clip mode
  if (window.__latentClipState && window.__latentClipState.mode === "selecting") return

  // ── Highlight overlay (position:absolute — stays with element on scroll) ──
  var overlay = document.getElementById("latent-clip-overlay")
  if (!overlay) {
    overlay = document.createElement("div")
    overlay.id = "latent-clip-overlay"
    overlay.style.cssText =
      "position:absolute;border:2px solid rgba(59,130,246,0.7);" +
      "background:rgba(59,130,246,0.08);pointer-events:none;z-index:99998;" +
      "display:none;transition:all 0.1s ease"
    document.body.appendChild(overlay)
  }

  // ── Label (position:absolute — tracks with overlay) ──
  var label = document.getElementById("latent-clip-label")
  if (!label) {
    label = document.createElement("div")
    label.id = "latent-clip-label"
    label.style.cssText =
      "position:absolute;z-index:99998;pointer-events:none;" +
      "background:rgba(0,0,0,0.8);color:rgba(59,130,246,0.9);" +
      "font-size:10px;font-family:monospace;padding:1px 4px;" +
      "border-radius:2px;display:none;white-space:nowrap"
    document.body.appendChild(label)
  }

  // ── Adjust panel (position:fixed — floating UI near selection) ──
  var adjustPanel = document.getElementById("latent-clip-adjust")
  if (!adjustPanel) {
    var PANEL_CSS = "position:fixed;z-index:99999;display:none;align-items:center;gap:2px;" +
      "background:rgba(0,0,0,0.75);backdrop-filter:blur(8px);" +
      "border:1px solid rgba(255,255,255,0.1);border-radius:10px;" +
      "padding:4px 6px;font-family:-apple-system,sans-serif;user-select:none"

    adjustPanel = document.createElement("div")
    adjustPanel.id = "latent-clip-adjust"
    adjustPanel.style.cssText = PANEL_CSS

    function mkBtn(text, title, onClick) {
      var b = document.createElement("button")
      b.title = title
      b.textContent = text
      b.style.cssText = "border:none;cursor:pointer;background:none;padding:4px 6px;" +
        "border-radius:6px;color:rgba(255,255,255,0.6);font-size:13px;" +
        "transition:color 0.15s,background 0.15s;" +
        "display:flex;align-items:center;justify-content:center;line-height:1"
      b.onmouseenter = function () { b.style.color = "#fff"; b.style.background = "rgba(255,255,255,0.1)" }
      b.onmouseleave = function () { b.style.color = "rgba(255,255,255,0.6)"; b.style.background = "none" }
      b.addEventListener("click", function (e) {
        e.stopPropagation()
        onClick()
      })
      return b
    }

    adjustPanel.appendChild(mkBtn("\u2191", "Parent element", function () { adjustSelection("up") }))
    adjustPanel.appendChild(mkBtn("\u2193", "Child element", function () { adjustSelection("down") }))
    adjustPanel.appendChild(mkBtn("\u2190", "Previous sibling", function () { adjustSelection("left") }))
    adjustPanel.appendChild(mkBtn("\u2192", "Next sibling", function () { adjustSelection("right") }))

    var divider = document.createElement("span")
    divider.style.cssText = "width:1px;height:18px;background:rgba(255,255,255,0.15);margin:0 4px"
    adjustPanel.appendChild(divider)

    var confirmBtn = mkBtn("\u2713", "Confirm selection", function () { confirmSelection() })
    confirmBtn.style.color = "#3fb950"
    adjustPanel.appendChild(confirmBtn)
    adjustPanel.appendChild(mkBtn("\u2715", "Cancel selection", function () { exitClipMode() }))

    document.body.appendChild(adjustPanel)
  }

  // ── State ──
  window.__latentClipState = {
    mode: "selecting",
    selected: null,
    navStack: [],
    depthIndex: 0,
  }

  function showOverlay(el) {
    if (!el) {
      overlay.style.display = "none"
      label.style.display = "none"
      return
    }
    var r = el.getBoundingClientRect()
    overlay.style.left = (r.left + window.scrollX) + "px"
    overlay.style.top = (r.top + window.scrollY) + "px"
    overlay.style.width = r.width + "px"
    overlay.style.height = r.height + "px"
    overlay.style.display = "block"
    var tag = el.tagName ? el.tagName.toLowerCase() : "?"
    label.textContent = tag + " " + Math.round(r.width) + "\u00d7" + Math.round(r.height)
    label.style.left = (r.left + window.scrollX) + "px"
    label.style.top = (r.top + window.scrollY - 16) + "px"
    label.style.display = "block"
  }

  function positionAdjustPanel(el) {
    if (!el || !adjustPanel) return
    var r = el.getBoundingClientRect()
    var panelHeight = 36
    var panelWidth = 250
    var left = Math.max(8, Math.min(r.left + r.width / 2 - panelWidth / 2, window.innerWidth - panelWidth - 8))
    var top = r.top - panelHeight - 8
    if (top < 8) top = Math.min(r.bottom + 8, window.innerHeight - 50)
    adjustPanel.style.left = left + "px"
    adjustPanel.style.top = top + "px"
    adjustPanel.style.display = "flex"
  }

  function onMouseMove(e) {
    var state = window.__latentClipState
    if (!state || state.mode !== "selecting") return
    var target = e.target
    if (target.id === "latent-clip-overlay" || target.id === "latent-clip-label") return
    if (target.closest && (target.closest("#latent-action-panel") || target.closest("#latent-clip-adjust"))) return
    showOverlay(target)
  }

  function onClick(e) {
    var state = window.__latentClipState
    if (!state || state.mode !== "selecting") return
    var target = e.target
    if (target.closest && (target.closest("#latent-action-panel") || target.closest("#latent-clip-adjust"))) return
    if (target.id === "latent-clip-overlay" || target.id === "latent-clip-label") return
    e.preventDefault()
    e.stopPropagation()
    state.selected = target
    state.navStack = [target]
    state.depthIndex = 0
    state.mode = "adjusting"
    showOverlay(target)
    positionAdjustPanel(target)
    // Remove mousemove so highlight stays on selected element
    document.removeEventListener("mousemove", onMouseMove, true)
    document.removeEventListener("click", onClick, true)
  }

  function onKeyDown(e) {
    var state = window.__latentClipState
    if (!state) return
    if (state.mode !== "selecting" && state.mode !== "adjusting") return
    if (e.key === "Escape") {
      exitClipMode()
      return
    }
    if (state.mode === "adjusting") {
      if (e.key === "Enter") { confirmSelection(); return }
      if (e.key === "ArrowUp") { e.preventDefault(); adjustSelection("up"); positionAdjustPanel(state.selected) }
      if (e.key === "ArrowDown") { e.preventDefault(); adjustSelection("down"); positionAdjustPanel(state.selected) }
      if (e.key === "ArrowLeft") { e.preventDefault(); adjustSelection("left"); positionAdjustPanel(state.selected) }
      if (e.key === "ArrowRight") { e.preventDefault(); adjustSelection("right"); positionAdjustPanel(state.selected) }
    }
  }

  document.addEventListener("mousemove", onMouseMove, true)
  document.addEventListener("click", onClick, true)
  document.addEventListener("keydown", onKeyDown, true)

  // Store handler references for cleanup
  window.__latentClipState._onMouseMove = onMouseMove
  window.__latentClipState._onClick = onClick
  window.__latentClipState._onKeyDown = onKeyDown
  window.__latentClipState._showOverlay = showOverlay
  window.__latentClipState._positionAdjustPanel = positionAdjustPanel
}

/**
 * exitClipMode — remove highlight overlay, adjust panel, handlers, and clip state.
 */
export function exitClipMode() {
  var state = window.__latentClipState
  if (state) {
    if (state._onMouseMove) document.removeEventListener("mousemove", state._onMouseMove, true)
    if (state._onClick) document.removeEventListener("click", state._onClick, true)
    if (state._onKeyDown) document.removeEventListener("keydown", state._onKeyDown, true)
  }

  var overlay = document.getElementById("latent-clip-overlay")
  if (overlay) overlay.style.display = "none"

  var label = document.getElementById("latent-clip-label")
  if (label) label.style.display = "none"

  var adjustPanel = document.getElementById("latent-clip-adjust")
  if (adjustPanel) adjustPanel.style.display = "none"

  // Reset clip button style
  var clipBtn = document.getElementById("latent-clip-btn")
  if (clipBtn) {
    clipBtn.style.color = "rgba(255,255,255,0.6)"
    clipBtn.style.boxShadow = "none"
  }

  window.__latentClipState = null
}

/**
 * adjustSelection — navigate the DOM relative to the current selection.
 *
 * Uses a stack-based approach: "up" walks to parent (pushing onto stack),
 * "down" returns to remembered child or explores firstElementChild,
 * "left"/"right" move to siblings.
 *
 * @param direction — "up", "down", "left", or "right"
 */
export function adjustSelection(direction) {
  var state = window.__latentClipState
  if (!state || !state.selected) return

  var navStack = state.navStack
  var depthIndex = state.depthIndex

  if (direction === "up") {
    if (navStack[depthIndex + 1]) {
      depthIndex++
    } else {
      var parent = navStack[depthIndex].parentElement
      if (parent && parent !== document.body && parent !== document.documentElement) {
        navStack.push(parent)
        depthIndex++
      }
    }
  } else if (direction === "down") {
    if (depthIndex > 0) {
      depthIndex--
    } else {
      var child = navStack[0].firstElementChild
      if (child) {
        navStack.unshift(child)
      }
    }
  } else if (direction === "left") {
    var prev = navStack[depthIndex].previousElementSibling
    if (prev) {
      navStack[depthIndex] = prev
      navStack.length = depthIndex + 1
    }
  } else if (direction === "right") {
    var next = navStack[depthIndex].nextElementSibling
    if (next) {
      navStack[depthIndex] = next
      navStack.length = depthIndex + 1
    }
  }

  state.depthIndex = depthIndex
  state.selected = navStack[depthIndex]

  // Update highlight overlay position (absolute positioning with scroll offsets)
  var el = state.selected
  if (el) {
    var overlay = document.getElementById("latent-clip-overlay")
    var label = document.getElementById("latent-clip-label")
    if (overlay) {
      var r = el.getBoundingClientRect()
      overlay.style.left = (r.left + window.scrollX) + "px"
      overlay.style.top = (r.top + window.scrollY) + "px"
      overlay.style.width = r.width + "px"
      overlay.style.height = r.height + "px"
      overlay.style.display = "block"
    }
    if (label) {
      var r2 = el.getBoundingClientRect()
      var tag = el.tagName ? el.tagName.toLowerCase() : "?"
      label.textContent = tag + " " + Math.round(r2.width) + "\u00d7" + Math.round(r2.height)
      label.style.left = (r2.left + window.scrollX) + "px"
      label.style.top = (r2.top + window.scrollY - 16) + "px"
      label.style.display = "block"
    }
  }
}

/**
 * confirmSelection — extract data from the selected element and notify backend.
 *
 * Builds a CSS selector path, gathers outerHTML/title/url/timestamp,
 * sends via __latentInfoNotify, then exits clip mode.
 */
export function confirmSelection() {
  var state = window.__latentClipState
  if (!state || !state.selected) return

  var el = state.selected

  // Build CSS selector path
  var parts = []
  var current = el
  while (current && current !== document.body && current !== document.documentElement) {
    var tag = current.tagName.toLowerCase()
    if (current.id) {
      parts.unshift(tag + "#" + current.id)
      break
    }
    var classes = current.className
    if (typeof classes === "string" && classes.trim()) {
      var classList = classes.trim().split(/\s+/)
      var classStr = ""
      for (var c = 0; c < classList.length; c++) {
        classStr = classStr + "." + classList[c]
      }
      parts.unshift(tag + classStr)
    } else {
      var sib = current
      var nth = 1
      while ((sib = sib.previousElementSibling)) {
        if (sib.tagName === current.tagName) nth++
      }
      parts.unshift(tag + ":nth-of-type(" + nth + ")")
    }
    current = current.parentElement
  }
  var selector = parts.join(" > ")

  var html = el.outerHTML
  var title = document.title
  var url = location.href
  var timestamp = new Date().toISOString()

  // Extract tweet author metadata on X/Twitter pages
  var handle = ""
  var displayName = ""
  var avatarUrl = ""
  var host = location.hostname
  if (host === "x.com" || host === "twitter.com" || host.endsWith(".x.com") || host.endsWith(".twitter.com")) {
    try {
      // Walk up from selected element to find the parent tweet article
      var tweet = el.closest && el.closest('article[data-testid="tweet"]')
      if (!tweet) tweet = el.closest && el.closest("article")
      if (tweet) {
        // Extract handle and display name from User-Name container
        var userNameEl = tweet.querySelector('[data-testid="User-Name"]')
        if (userNameEl) {
          // Display name is the first text-bearing span/link
          var nameSpans = userNameEl.querySelectorAll("span")
          for (var ns = 0; ns < nameSpans.length; ns++) {
            var txt = (nameSpans[ns].textContent || "").trim()
            if (txt && txt !== "\u00b7" && !txt.startsWith("@")) {
              displayName = txt
              break
            }
          }
          // Handle is the @-prefixed link
          var links = userNameEl.querySelectorAll("a[href]")
          for (var nl = 0; nl < links.length; nl++) {
            var linkText = (links[nl].textContent || "").trim()
            if (linkText.startsWith("@")) {
              handle = linkText
              break
            }
          }
        }
        // Extract avatar URL
        var avatarEl = tweet.querySelector('[data-testid="Tweet-User-Avatar"] img')
        if (avatarEl) {
          avatarUrl = avatarEl.src || avatarEl.currentSrc || ""
        }
      }
    } catch (e) {
      // Tweet metadata extraction is best-effort
    }
  }

  var payload = JSON.stringify({
    type: "clip",
    html: html,
    url: url,
    title: title,
    selector: selector,
    timestamp: timestamp,
    handle: handle || undefined,
    displayName: displayName || undefined,
    avatarUrl: avatarUrl || undefined,
  })

  __latentInfoNotify(payload)
  exitClipMode()
}

/**
 * initClipButton — add a scissors clip button into a panel section.
 *
 * @param opts — { sectionId: string } identifying the panel section by data-section attribute
 */
export function initClipButton(opts) {
  var sectionId = opts && opts.sectionId
  if (!sectionId) return
  var container = document.getElementById("latent-action-panel-content")
  if (!container) return
  var sectionEl = container.querySelector('[data-section="' + sectionId + '"]')
  if (!sectionEl) return
  // Don't add duplicate button
  if (sectionEl.querySelector("#latent-clip-btn")) return

  var btn = document.createElement("button")
  btn.id = "latent-clip-btn"
  btn.title = "Clip element"
  btn.style.cssText =
    "border:none;cursor:pointer;background:none;padding:4px 6px;" +
    "border-radius:6px;color:rgba(255,255,255,0.6);font-size:11px;" +
    "transition:color 0.15s,background 0.15s;" +
    "display:flex;align-items:center;justify-content:center;gap:3px"
  var icon = document.createElement("span")
  icon.textContent = "\u2702"
  icon.style.fontSize = "14px"
  btn.appendChild(icon)
  var label = document.createElement("span")
  label.textContent = "clip"
  btn.appendChild(label)
  btn.onmouseenter = function () {
    btn.style.color = "#fff"
    btn.style.background = "rgba(255,255,255,0.1)"
  }
  btn.onmouseleave = function () {
    btn.style.color = "rgba(255,255,255,0.6)"
    btn.style.background = "none"
  }
  btn.addEventListener("click", function (e) {
    e.stopPropagation()
    var state = window.__latentClipState
    if (state && (state.mode === "selecting" || state.mode === "adjusting")) {
      exitClipMode()
    } else {
      initClipMode()
      btn.style.color = "#3b82f6"
      btn.style.boxShadow = "0 0 6px rgba(59,130,246,0.5)"
    }
  })

  sectionEl.appendChild(btn)
}

/**
 * initAutoClipButton — add an auto-clip button into a panel section.
 * Same scissors icon as clip, but labelled "auto". Sends { type: "auto-clip" }
 * notification on click so the backend can run the matching auto-detect pattern.
 *
 * @param opts — { sectionId: string }
 */
export function initAutoClipButton(opts) {
  var sectionId = opts && opts.sectionId
  if (!sectionId) return
  var container = document.getElementById("latent-action-panel-content")
  if (!container) return
  var sectionEl = container.querySelector('[data-section="' + sectionId + '"]')
  if (!sectionEl) return
  if (sectionEl.querySelector("#latent-auto-clip-btn")) return

  var btn = document.createElement("button")
  btn.id = "latent-auto-clip-btn"
  btn.title = "Auto clip"
  btn.style.cssText =
    "border:none;cursor:pointer;background:none;padding:4px 6px;" +
    "border-radius:6px;color:rgba(255,255,255,0.6);font-size:11px;" +
    "transition:color 0.15s,background 0.15s;" +
    "display:flex;align-items:center;justify-content:center;gap:3px"
  var icon = document.createElement("span")
  icon.textContent = "\u2702"
  icon.style.fontSize = "14px"
  btn.appendChild(icon)
  var label = document.createElement("span")
  label.textContent = "auto"
  btn.appendChild(label)
  btn.onmouseenter = function () {
    btn.style.color = "#fff"
    btn.style.background = "rgba(255,255,255,0.1)"
  }
  btn.onmouseleave = function () {
    btn.style.color = "rgba(255,255,255,0.6)"
    btn.style.background = "none"
  }
  btn.addEventListener("click", function (e) {
    e.stopPropagation()
    // Brief visual feedback
    btn.style.color = "#3b82f6"
    btn.style.boxShadow = "0 0 6px rgba(59,130,246,0.5)"
    setTimeout(function () {
      btn.style.color = "rgba(255,255,255,0.6)"
      btn.style.boxShadow = "none"
    }, 600)
    // Notify backend to run auto-clip extraction
    if (typeof window.__latentInfoNotify === "function") {
      window.__latentInfoNotify(JSON.stringify({ type: "auto-clip" }))
    }
  })

  sectionEl.appendChild(btn)
}

/**
 * showClipToast — show or update a transient toast notification after clipping.
 *
 * @param opts — { sourceKey: string, status: "stored" | "processed" | "error", message?: string }
 */
export function showClipToast(opts) {
  if (!opts) return
  var TOAST_ID = "latent-clip-toast"
  var toast = document.getElementById(TOAST_ID)

  if (!toast) {
    toast = document.createElement("div")
    toast.id = TOAST_ID
    toast.style.cssText =
      "position:fixed;z-index:99999;" +
      "background:rgba(13,17,23,0.92);backdrop-filter:blur(12px);" +
      "border:1px solid rgba(255,255,255,0.1);border-radius:10px;" +
      "padding:8px 14px;font-family:-apple-system,sans-serif;" +
      "font-size:12px;color:rgba(255,255,255,0.8);max-width:340px;" +
      "box-shadow:0 4px 16px rgba(0,0,0,0.4);transition:opacity 0.3s;" +
      "pointer-events:none"
    document.body.appendChild(toast)
  }

  // Position the toast below the action panel, falling back to bottom-right
  var panel = document.getElementById("latent-action-panel")
  if (panel) {
    var r = panel.getBoundingClientRect()
    toast.style.top = (r.bottom + 8) + "px"
    toast.style.right = (window.innerWidth - r.right) + "px"
    toast.style.bottom = "auto"
    toast.style.left = "auto"
  } else {
    toast.style.top = "auto"
    toast.style.left = "auto"
    toast.style.bottom = "16px"
    toast.style.right = "16px"
  }

  // Clear any pending auto-dismiss timer
  if (window.__latentClipToastTimer) {
    clearTimeout(window.__latentClipToastTimer)
    window.__latentClipToastTimer = null
  }

  var statusIcon = opts.status === "stored" ? "\u2702 "  // ✂
    : opts.status === "processed" ? "\u2713 "            // ✓
    : "\u2717 "                                          // ✗
  var statusColor = opts.status === "stored" ? "#58a6ff"
    : opts.status === "processed" ? "#3fb950"
    : "#f85149"

  var key = opts.sourceKey || ""
  var shortKey = key.length > 28 ? key.slice(0, 12) + "\u2026" + key.slice(-12) : key
  var msg = opts.message || (opts.status === "stored" ? "Clip saved" : opts.status === "processed" ? "Markdown ready" : "Error")

  toast.innerHTML = ""
  var line = document.createElement("div")
  line.style.cssText = "display:flex;align-items:center;gap:6px"

  var icon = document.createElement("span")
  icon.style.color = statusColor
  icon.textContent = statusIcon
  line.appendChild(icon)

  var text = document.createElement("span")
  text.textContent = msg
  line.appendChild(text)

  toast.appendChild(line)

  if (shortKey) {
    var keyLine = document.createElement("div")
    keyLine.style.cssText = "font-size:10px;color:rgba(255,255,255,0.4);margin-top:2px;font-family:monospace"
    keyLine.textContent = shortKey
    toast.appendChild(keyLine)
  }

  toast.style.opacity = "1"
  toast.style.display = "block"

  // Auto-dismiss after 5 seconds
  window.__latentClipToastTimer = setTimeout(function () {
    toast.style.opacity = "0"
    setTimeout(function () { toast.style.display = "none" }, 300)
  }, 5000)
}
