// @ts-nocheck
/**
 * arxiv collector — page-side functions.
 *
 * Serialized via .toString() and injected into arxiv.org abstract pages.
 * Extracts paper metadata from citation_* meta tags with DOM fallbacks.
 */

/**
 * extractPaper — extract paper metadata from the current arxiv abstract page.
 * Prefers citation_* meta tags, falls back to DOM selectors.
 */
export function extractPaper() {
  function meta(name) {
    var el = document.querySelector('meta[name="' + name + '"]')
    return el ? el.getAttribute("content") || "" : ""
  }

  function metaAll(name) {
    var els = document.querySelectorAll('meta[name="' + name + '"]')
    var results = []
    for (var i = 0; i < els.length; i++) {
      var v = els[i].getAttribute("content")
      if (v) results.push(v.trim())
    }
    return results
  }

  // arxiv ID from URL
  var pathMatch = location.pathname.match(/\/abs\/(.+?)(?:v\d+)?$/)
  var arxivId = pathMatch ? pathMatch[1] : meta("citation_arxiv_id") || ""

  // Title: meta tag first, then h1
  var title = meta("citation_title")
  if (!title) {
    var h1 = document.querySelector("h1.title")
    if (h1) {
      title = h1.textContent.replace(/^Title:\s*/i, "").trim()
    }
  }

  // Authors: meta tags first, then DOM
  var authors = metaAll("citation_author")
  if (authors.length === 0) {
    var authorDiv = document.querySelector("div.authors")
    if (authorDiv) {
      var links = authorDiv.querySelectorAll("a")
      for (var i = 0; i < links.length; i++) {
        var t = links[i].textContent.trim()
        if (t) authors.push(t)
      }
    }
  }

  // Abstract: blockquote
  var abstract = ""
  var bq = document.querySelector("blockquote.abstract")
  if (bq) {
    abstract = bq.textContent.replace(/^Abstract:\s*/i, "").trim()
  }

  // Categories: subjects table cell
  var categories = []
  var subjectsEl = document.querySelector("td.subjects")
  if (subjectsEl) {
    var spans = subjectsEl.querySelectorAll("span.primary-subject, span")
    if (spans.length > 0) {
      for (var j = 0; j < spans.length; j++) {
        var txt = spans[j].textContent.trim()
        // Extract category code like "cs.CR" from "Computer Science > Cryptography (cs.CR)"
        var codeMatch = txt.match(/\(([^)]+)\)/)
        if (codeMatch) categories.push(codeMatch[1])
      }
    }
    if (categories.length === 0) {
      // Fallback: parse raw text
      var raw = subjectsEl.textContent.trim()
      var codes = raw.match(/[a-z-]+\.[A-Z]{2}/g)
      if (codes) categories = codes
    }
  }

  // Submission date
  var submittedAt = meta("citation_date") || meta("citation_online_date") || ""
  if (!submittedAt) {
    var dateline = document.querySelector("div.dateline")
    if (dateline) {
      var dateMatch = dateline.textContent.match(/(\d{1,2}\s+\w+\s+\d{4})/)
      if (dateMatch) {
        try { submittedAt = new Date(dateMatch[1]).toISOString() } catch(e) {}
      }
    }
  }
  // Normalize to ISO if it's just a date string
  if (submittedAt && !submittedAt.includes("T")) {
    try { submittedAt = new Date(submittedAt).toISOString() } catch(e) {}
  }

  // PDF URL
  var pdfUrl = meta("citation_pdf_url")
  if (!pdfUrl) {
    var pdfLink = document.querySelector('a[href*="/pdf/"]')
    if (pdfLink) pdfUrl = pdfLink.href
  }

  // Submission history — extract all versions with dates and sizes
  var versions = []
  var historyDiv = document.querySelector("div.submission-history")
  if (historyDiv) {
    var html = historyDiv.innerHTML
    // Match patterns like: [v1]</a>\n        Tue, 24 Jan 2023 18:52:59 UTC (3,550 KB)
    // or: [v1]</strong>\n        Mon, 17 Feb 2025 08:39:43 UTC (1,162 KB)
    var versionRegex = /\[v(\d+)\][\s\S]*?(\w{3},\s+\d{1,2}\s+\w+\s+\d{4}\s+[\d:]+\s+UTC)\s*\(([^)]+)\)/g
    var vm
    while ((vm = versionRegex.exec(html)) !== null) {
      var vDate = ""
      try { vDate = new Date(vm[2]).toISOString() } catch(e) { vDate = vm[2] }
      versions.push({
        version: "v" + vm[1],
        date: vDate,
        size: vm[3].trim(),
      })
    }
  }

  return {
    arxivId: arxivId,
    title: title,
    authors: authors,
    abstract: abstract,
    categories: categories,
    submittedAt: submittedAt,
    pdfUrl: pdfUrl || "",
    url: location.href,
    versions: versions,
  }
}

/**
 * addBadge — add a visual badge near the title showing collection datetime.
 * Uses li-scrape-badge class and same format/style as the x collector.
 * Green = newly collected, Yellow = already existed.
 * @param opts {{ isNew: boolean, collectedAt: string }}
 */
export function addBadge(opts) {
  var existing = document.querySelector("h1.title .li-scrape-badge")
  if (existing) existing.remove()

  var isNew = opts && opts.isNew
  var collectedAt = opts && opts.collectedAt || ""

  var ymd = ""
  var timeStr = ""
  if (collectedAt) {
    try {
      var d = new Date(collectedAt)
      var pad = function(n) { return n < 10 ? "0" + n : "" + n }
      ymd = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
      timeStr = " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    } catch(e) {
      ymd = collectedAt.slice(0, 10)
    }
  }

  var badge = document.createElement("span")
  badge.className = "li-scrape-badge"
  badge.textContent = ymd + timeStr
  var bgColor = isNew
    ? "background:rgba(38,222,176,0.18);color:#16a085"
    : "background:rgba(229,168,38,0.18);color:#d6a130"
  badge.style.cssText = "margin-left:8px;padding:2px 6px;border-radius:999px;font-size:11px;font-weight:600;letter-spacing:0.02em;vertical-align:middle;" + bgColor

  var title = document.querySelector("h1.title")
  if (title) {
    title.appendChild(badge)
  }
}
