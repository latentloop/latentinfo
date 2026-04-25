// @ts-nocheck
/**
 * GitHub collector page-side functions.
 *
 * Serialized via .toString() and injected into github.com repository pages.
 */

export async function extractReadme() {
  function parseRepoIdentity() {
    var parts = location.pathname.split("/").filter(Boolean)
    if (parts.length < 2) return null

    var owner = decodeURIComponent(parts[0])
    var repo = decodeURIComponent(parts[1]).replace(/\.git$/, "")
    if (!owner || !repo) return null

    var excludedOwners = {
      settings: true,
      notifications: true,
      pulls: true,
      issues: true,
      marketplace: true,
      explore: true,
      topics: true,
      trending: true,
      orgs: true,
      new: true,
    }
    if (excludedOwners[owner]) return null

    return {
      owner: owner,
      repo: repo,
      fullName: owner + "/" + repo,
      url: "https://github.com/" + owner + "/" + repo,
    }
  }

  function decodeBase64Utf8(value) {
    var binary = atob(String(value || "").replace(/\s/g, ""))
    var bytes = new Uint8Array(binary.length)
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new TextDecoder().decode(bytes)
  }

  async function fetchJson(url) {
    var response = await fetch(url, {
      headers: { Accept: "application/vnd.github+json" },
    })
    if (!response.ok) return null
    return await response.json()
  }

  function domReadmeText() {
    var readme = document.querySelector("#readme article, article.markdown-body")
    return readme && readme.innerText ? readme.innerText.trim() : ""
  }

  function domReadmeImageUrls() {
    var readme = document.querySelector("#readme article, article.markdown-body")
    if (!readme) return []

    var seen = {}
    var urls = []
    var imgs = readme.querySelectorAll("img[src]")
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i]
      var src = img.currentSrc || img.src || img.getAttribute("src") || ""
      if (!src || !/^https?:\/\//i.test(src) || seen[src]) continue
      seen[src] = true
      urls.push(src)
    }
    return urls
  }

  var identity = parseRepoIdentity()
  if (!identity) return null

  var apiBase = "https://api.github.com/repos/" + identity.owner + "/" + identity.repo
  var results = await Promise.all([
    fetchJson(apiBase),
    fetchJson(apiBase + "/readme"),
  ])
  var repoMeta = results[0]
  var readme = results[1]
  var domText = domReadmeText()
  var imageUrls = domReadmeImageUrls()

  var readmeMarkdown = ""
  if (readme && readme.content) {
    readmeMarkdown = decodeBase64Utf8(readme.content)
  } else if (domText) {
    readmeMarkdown = domText
  }
  if (!readmeMarkdown.trim()) return null

  return {
    owner: identity.owner,
    repo: identity.repo,
    fullName: identity.fullName,
    description: repoMeta && typeof repoMeta.description === "string" ? repoMeta.description : "",
    defaultBranch: repoMeta && typeof repoMeta.default_branch === "string" ? repoMeta.default_branch : "",
    stars: repoMeta && typeof repoMeta.stargazers_count === "number" ? repoMeta.stargazers_count : 0,
    forks: repoMeta && typeof repoMeta.forks_count === "number" ? repoMeta.forks_count : 0,
    language: repoMeta && typeof repoMeta.language === "string" ? repoMeta.language : "",
    readmePath: readme && typeof readme.path === "string" ? readme.path : "README",
    readmeSha: readme && typeof readme.sha === "string" ? readme.sha : "",
    readmeMarkdown: readmeMarkdown,
    readmeText: domText || readmeMarkdown,
    imageUrls: imageUrls,
    htmlUrl: readme && typeof readme.html_url === "string" ? readme.html_url : identity.url,
    rawUrl: readme && typeof readme.download_url === "string" ? readme.download_url : "",
    url: identity.url,
  }
}

export function addBadge(opts) {
  var existing = document.querySelector(".li-github-readme-badge")
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
  badge.className = "li-github-readme-badge"
  badge.textContent = "README " + ymd + timeStr
  var bgColor = isNew
    ? "background:rgba(35,134,54,0.18);color:#3fb950"
    : "background:rgba(187,128,9,0.18);color:#d29922"
  badge.style.cssText = "display:inline-flex;align-items:center;margin-left:8px;padding:2px 6px;border-radius:999px;font-size:11px;font-weight:600;letter-spacing:0.02em;vertical-align:middle;" + bgColor

  var anchor =
    document.querySelector("strong[itemprop='name'] a") ||
    document.querySelector("[data-testid='repository-name-heading'] a") ||
    document.querySelector("h1 strong a") ||
    document.querySelector("h1")
  if (anchor) anchor.appendChild(badge)
}
