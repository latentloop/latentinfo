#!/usr/bin/env node
/**
 * Tracker-discipline lint.
 *
 * Page-side collector code must register browser resources (window/document
 * listeners, MutationObservers, long-lived timers) through the ResourceTracker
 * so disposeAll() can clean them on backend reattach. Otherwise, orphaned
 * observers fire against a closed CDP binding and throw ReferenceError.
 *
 * This script fails if any file under src/collectors/**\/*.ts (excluding
 * *.test.ts) uses a bare bypass pattern without a `// tracker-bypass: <reason>`
 * comment on the same line or the preceding line.
 *
 * Banned patterns (unless annotated):
 *   - window.addEventListener(      — route via tracker.addListener
 *   - document.addEventListener(    — route via tracker.addListener
 *   - new MutationObserver(         — route via tracker.addObserver
 *   - setTimeout(                   — route via tracker.addTimeout
 *   - setInterval(                  — route via tracker.addInterval
 *
 * Element-scoped listeners (btn.addEventListener, element.addEventListener
 * on DOM nodes owned by the collector) are NOT checked — those die with
 * their element and do not orphan on reattach.
 */

import { readFileSync } from "node:fs"
import { globSync } from "node:fs"
import { join } from "node:path"

const ROOT = new URL("..", import.meta.url).pathname
// Only check files that are primarily page-injected (toString-serialized and
// run inside the browser page context). Backend-side files like cdp-handler.ts
// may contain Node.js setTimeout calls that are NOT page-orphan concerns.
// Mixed files (a backend file with a page.evaluate() string that contains bare
// setTimeout) are the reviewer's responsibility.
const COLLECTORS_GLOB = "src/collectors/**/*page-{fns,functions}*.ts"

const PATTERNS = [
  { regex: /\bwindow\.addEventListener\(/, name: "bare window.addEventListener", suggestion: "tracker.addListener(id, window, event, handler, options)" },
  { regex: /\bdocument\.addEventListener\(/, name: "bare document.addEventListener", suggestion: "tracker.addListener(id, document, event, handler, options)" },
  { regex: /\bnew MutationObserver\(/, name: "bare new MutationObserver", suggestion: "tracker.addObserver(id, new MutationObserver(...), target, config)" },
  { regex: /(^|[^.\w])setTimeout\(/, name: "bare setTimeout", suggestion: "tracker.addTimeout(id, fn, delay)" },
  { regex: /(^|[^.\w])setInterval\(/, name: "bare setInterval", suggestion: "tracker.addInterval(id, fn, delay)" },
]

const BYPASS_RE = /\btracker-bypass\b/

const files = globSync(COLLECTORS_GLOB, { cwd: ROOT })
  .filter(f => !f.endsWith(".test.ts"))

let violations = 0

for (const rel of files) {
  const abs = join(ROOT, rel)
  const lines = readFileSync(abs, "utf8").split("\n")

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const { regex, name, suggestion } of PATTERNS) {
      if (!regex.test(line)) continue
      // Skip comment-only lines (documentation referencing the pattern)
      const trimmed = line.trimStart()
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue
      // Allow if same-line or previous-line has a tracker-bypass comment
      const prev = i > 0 ? lines[i - 1] : ""
      if (BYPASS_RE.test(line) || BYPASS_RE.test(prev)) continue

      violations++
      console.error(`✗ ${rel}:${i + 1}  ${name}`)
      console.error(`  ${line.trim()}`)
      console.error(`  hint: use ${suggestion}`)
      console.error(`  or annotate with "// tracker-bypass: <reason>" on this or the previous line\n`)
    }
  }
}

if (violations > 0) {
  console.error(`\ntracker-discipline: ${violations} violation(s) in ${files.length} file(s)`)
  process.exit(1)
}

console.log(`tracker-discipline: clean (${files.length} files checked)`)
