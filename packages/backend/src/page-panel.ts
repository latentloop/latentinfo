// @ts-nocheck
/**
 * Shared floating control panel — page-side functions.
 *
 * These functions are serialized via .toString() and injected into the browser
 * page context via installModule(). They reference browser globals (window,
 * document, DOM types) that don't exist in Node.js — hence @ts-nocheck.
 *
 * Module name: "__panel" (double underscore = framework-owned, not collector-owned).
 * All function names use __panel prefix to avoid window global collisions
 * (installModule exposes every function as window.<name>).
 *
 * In-page access: window.__latent.__panel.__panelCreate(), etc.
 */

/* eslint-disable @typescript-eslint/no-unsafe-function-type */

// NOTE: No module-level variables! Functions serialized via .toString() cannot
// reference closure variables — all constants must be inlined in each function.

/**
 * __panelCreate — create the shared floating panel container.
 * Idempotent: returns existing panel if already created.
 */
export function __panelCreate() {
  if (document.getElementById("latent-action-panel")) return

  var panel = document.createElement("div")
  panel.id = "latent-action-panel"
  panel.style.cssText =
    "position:fixed;top:12px;right:12px;z-index:99999;" +
    "display:flex;flex-direction:column;gap:0;" +
    "background:rgba(13,17,23,0.92);backdrop-filter:blur(12px);" +
    "border:1px solid rgba(255,255,255,0.1);border-radius:12px;" +
    "font-family:-apple-system,sans-serif;user-select:none;" +
    "box-shadow:0 4px 16px rgba(0,0,0,0.4);overflow:hidden;width:fit-content;" +
    "opacity:0.5;transition:opacity 0.25s ease"

  panel.addEventListener("mouseenter", function () {
    panel.style.opacity = "1"
  })
  panel.addEventListener("mouseleave", function () {
    if (!panel._dragging) panel.style.opacity = "0.5"
  })

  // Card header
  var header = document.createElement("div")
  header.style.cssText =
    "padding:6px 10px;font-size:11px;font-weight:600;color:rgba(255,255,255,0.5);" +
    "letter-spacing:0.5px;border-bottom:1px solid rgba(255,255,255,0.08);text-align:right"
  header.textContent = "LatentInfo"
  header.style.cursor = "grab"

  header.addEventListener("mousedown", function (e) {
    e.preventDefault()
    var rect = panel.getBoundingClientRect()
    panel.style.left = rect.left + "px"
    panel.style.top = rect.top + "px"
    panel.style.right = "auto"
    panel._dragging = true
    panel._dragOffsetX = e.clientX - rect.left
    panel._dragOffsetY = e.clientY - rect.top
    header.style.cursor = "grabbing"
    panel.style.opacity = "1"
  })

  document.addEventListener("mousemove", function (e) {
    if (!panel._dragging) return
    var x = e.clientX - panel._dragOffsetX
    var y = e.clientY - panel._dragOffsetY
    var maxX = window.innerWidth - panel.offsetWidth
    var maxY = window.innerHeight - panel.offsetHeight
    panel.style.left = Math.max(0, Math.min(x, maxX)) + "px"
    panel.style.top = Math.max(0, Math.min(y, maxY)) + "px"
  })

  document.addEventListener("mouseup", function () {
    if (!panel._dragging) return
    panel._dragging = false
    header.style.cursor = "grab"
  })

  panel.appendChild(header)

  // Content area for sections
  var content = document.createElement("div")
  content.id = "latent-action-panel-content"
  content.style.cssText = "display:flex;flex-direction:column;gap:0;padding:2px 0"
  panel.appendChild(content)

  document.body.appendChild(panel)

  // Inject shared styles (focus dot, etc.) if not already present
  if (!document.getElementById("latent-panel-styles")) {
    var style = document.createElement("style")
    style.id = "latent-panel-styles"
    style.textContent =
      ".latent-focus-dot{width:10px;height:10px;border-radius:50%;" +
      "background:#22c55e;box-shadow:0 0 6px rgba(34,197,94,0.5);" +
      "pointer-events:none;margin:4px auto 0;}"
    document.head.appendChild(style)
  }
}

/**
 * __panelAddSection — add a collector's section container to the panel.
 * Accepts { id: string }. Auto-inserts 1px divider between sections.
 * Section is queryable via document.querySelector('[data-section="<id>"]').
 */
export function __panelAddSection(opts) {
  var id = opts && opts.id
  if (!id) return
  var container = document.getElementById("latent-action-panel-content")
  if (!container) return

  // Don't add duplicate sections
  if (container.querySelector('[data-section="' + id + '"]')) return

  // Add horizontal divider if this isn't the first section
  var existingSections = container.querySelectorAll("[data-section]")
  if (existingSections.length > 0) {
    var divider = document.createElement("div")
    divider.className = "latent-panel-divider"
    divider.setAttribute("data-divider-before", id)
    divider.style.cssText =
      "height:1px;background:rgba(255,255,255,0.08);margin:0"
    container.appendChild(divider)
  }

  var section = document.createElement("div")
  section.setAttribute("data-section", id)
  section.style.cssText = "display:flex;align-items:center;justify-content:flex-end;gap:2px;padding:2px 6px"

  container.appendChild(section)
}

/**
 * __panelRemoveSection — remove a collector's section and its divider.
 */
export function __panelRemoveSection(id) {
  if (!id) return
  var container = document.getElementById("latent-action-panel-content")
  if (!container) return

  var section = container.querySelector('[data-section="' + id + '"]')
  if (section) section.remove()

  var divider = container.querySelector('[data-divider-before="' + id + '"]')
  if (divider) divider.remove()

  // If panel is now empty, remove the whole panel
  if (container.querySelectorAll("[data-section]").length === 0) {
    var panel = document.getElementById("latent-action-panel")
    if (panel) panel.remove()
    var style = document.getElementById("latent-panel-styles")
    if (style) style.remove()
  }
}

/**
 * __panelIsCreated — check if panel already exists on this page.
 */
export function __panelIsCreated() {
  return !!document.getElementById("latent-action-panel")
}
