import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import type { JobDefinition, JobContext } from "../types.js"

const DEBOUNCE_MS = 5000
const BATCH_SIZE = 20
const MAX_FAILS = 3

const DEFAULT_ENDPOINT = "http://127.0.0.1:1234/v1/chat/completions"
const DEFAULT_MODEL = "qwen3.5-4b"

interface JobConfig {
  endpoint?: string
  model?: string
}

function loadJobConfig(jobDir: string): JobConfig {
  const configPath = join(jobDir, "config.json")
  if (!existsSync(configPath)) return {}
  try {
    return JSON.parse(readFileSync(configPath, "utf-8")) as JobConfig
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// prompt.md parsing and writing
// ---------------------------------------------------------------------------

function parseTags(content: string): string[] {
  const m = content.match(/<!-- TAGS_START -->([\s\S]*?)<!-- TAGS_END -->/)
  if (!m) return []
  return m[1]!
    .split("\n")
    .map((l) => l.replace(/^-\s*/, "").trim())
    .filter(Boolean)
}

function parseBacklog(content: string): string[] {
  const m = content.match(/<!-- BACKLOG_START -->([\s\S]*?)<!-- BACKLOG_END -->/)
  if (!m) return []
  return m[1]!
    .split("\n")
    .map((l) => l.replace(/^-\s*/, "").trim())
    .filter(Boolean)
}

function writeTagSections(
  content: string,
  tags: string[],
  backlog: string[],
): string {
  const uniqueTags = [...new Set(tags)]
  const uniqueBacklog = [...new Set(backlog)].filter((b) => !uniqueTags.includes(b))
  const trimmedBacklog = uniqueBacklog.slice(0, 100)

  let out = content.replace(
    /<!-- TAGS_START -->[\s\S]*?<!-- TAGS_END -->/,
    "<!-- TAGS_START -->\n" +
      uniqueTags.map((t) => `- ${t}`).join("\n") +
      "\n<!-- TAGS_END -->",
  )
  out = out.replace(
    /<!-- BACKLOG_START -->[\s\S]*?<!-- BACKLOG_END -->/,
    "<!-- BACKLOG_START -->\n" +
      (trimmedBacklog.length > 0
        ? trimmedBacklog.map((t) => `- ${t}`).join("\n") + "\n"
        : "") +
      "<!-- BACKLOG_END -->",
  )
  return out
}

// ---------------------------------------------------------------------------
// LM Studio API
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: "system" | "user"
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
}

async function callLmStudio(messages: ChatMessage[], endpoint: string, model: string): Promise<string> {
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.3,
      max_tokens: 100,
    }),
    signal: AbortSignal.timeout(30000),
  })

  if (!resp.ok) {
    throw new Error(`LM Studio returned ${resp.status}: ${await resp.text()}`)
  }

  const data = (await resp.json()) as {
    choices: Array<{ message: { content: string } }>
  }

  const content = data.choices?.[0]?.message?.content
  if (!content) throw new Error("Empty response from LM Studio")
  return content.trim()
}

interface SanitizedTag {
  name: string
  isBacklog: boolean
}

/**
 * Sanitize tag name and classify based on known tag lists.
 * Returns the clean name (never prefixed) and whether it's a backlog tag.
 * Classification uses prompt.md's TAGS/BACKLOG sections as the authority.
 */
function sanitizeTag(tag: string, confirmedTags: string[], backlogTags: string[]): SanitizedTag {
  const hasPrefix = tag.startsWith("backlog:")
  let name = hasPrefix ? tag.slice("backlog:".length) : tag
  // Remove special chars — keep letters, numbers, spaces, / - _
  name = name.replace(/[<>"'`{}()\[\]\\|;:!@#$%^&*+=~]/g, "").trim()
  if (!name) throw new Error(`Tag is empty after sanitization: ${tag}`)

  const isConfirmed = confirmedTags.some((t) => t.toLowerCase() === name.toLowerCase())
  const isKnownBacklog = backlogTags.some((t) => t.toLowerCase() === name.toLowerCase())

  if (isConfirmed) {
    return { name, isBacklog: false }
  }
  if (isKnownBacklog || hasPrefix) {
    return { name, isBacklog: true }
  }
  // Unknown tag — treat as new backlog candidate
  return { name, isBacklog: true }
}

function parseTagResponse(raw: string, confirmedTags: string[], backlogTags: string[]): SanitizedTag {
  let tag: string | undefined
  try {
    const cleaned = raw.replace(/```json?\s*/g, "").replace(/```/g, "").trim()
    const parsed = JSON.parse(cleaned) as { tag?: string }
    if (parsed.tag && typeof parsed.tag === "string") tag = parsed.tag.trim()
  } catch {
    // Fall through
  }
  if (!tag) {
    const m = raw.match(/"tag"\s*:\s*"([^"]+)"/)
    if (m) tag = m[1]!.trim()
  }
  if (!tag) {
    const trimmed = raw.trim()
    if (trimmed && !trimmed.includes("\n") && trimmed.length < 100) tag = trimmed
  }
  if (!tag) throw new Error(`Could not parse tag from LLM response: ${raw.slice(0, 200)}`)
  return sanitizeTag(tag, confirmedTags, backlogTags)
}

// ---------------------------------------------------------------------------
// Job definition
// ---------------------------------------------------------------------------

const xTagJob: JobDefinition = {
  id: "x_tag",
  description: "Tag and classify collected tweets using AI prompts",
  dataFiles: ["prompt.md"],

  register(ctx) {
    ctx.on("x:collected", () => {
      // no-op: the job runner calls run() for jobs that have it
    })
  },

  async run(ctx) {
    // Concurrency is managed by the job-runner's drain queue — no per-job guard needed.
    return await xTagRunInner(ctx)
  },
}

async function xTagRunInner(ctx: JobContext): Promise<Record<string, unknown>> {
    // Debounce: skip if last successful run finished within DEBOUNCE_MS (unless manual)
    if (ctx.trigger !== "manual") {
      try {
        const recent = await ctx.db.execute({
          sql: "SELECT finished_at FROM job_runs WHERE job_id = 'x_tag' AND status = 'success' AND finished_at IS NOT NULL ORDER BY started_at DESC LIMIT 1",
          args: [],
        })
        if (recent.rows.length > 0) {
          const lastFinish = new Date(String(recent.rows[0]!.finished_at)).getTime()
          if (Date.now() - lastFinish < DEBOUNCE_MS) {
            ctx.log.info("Skipping x_tag run (within debounce window)")
            return { skipped: true, reason: "debounce" }
          }
        }
      } catch {
        // Proceed if debounce check fails
      }
    }

    const result = await runTagging(ctx)

    // Record run: always for manual, only when work was done for auto triggers
    const didWork = typeof result.total === "number" && result.total > 0
    if (didWork || ctx.trigger === "manual") {
      await ctx.recordRun(result)
      if (didWork) ctx.invalidateCache()
    }

    // If we processed a full batch, there may be more — trigger another run
    if (typeof result.total === "number" && result.total >= BATCH_SIZE) {
      ctx.log.info("Full batch processed, triggering follow-up run")
      setTimeout(() => ctx.triggerRun(), DEBOUNCE_MS)
    }

    return result
}

async function runTagging(ctx: JobContext): Promise<Record<string, unknown>> {
  const config = loadJobConfig(ctx.jobDir)
  const endpoint = config.endpoint || DEFAULT_ENDPOINT
  const model = config.model || DEFAULT_MODEL

  const promptPath = join(ctx.jobDir, "prompt.md")
  let promptContent: string
  try {
    promptContent = readFileSync(promptPath, "utf-8")
  } catch {
    ctx.log.warn(`Prompt file not found at ${promptPath}`)
    return { tagged: [], failed: [], total: 0, error: "prompt file not found" }
  }

  const tags = parseTags(promptContent)
  let backlog = parseBacklog(promptContent)
  ctx.log.info(`Tags: ${tags.length} confirmed, ${backlog.length} backlog`)

  // Targeted mode: process specific tweet IDs (allows re-tagging)
  const targetIds = ctx.params?.tweetIds as string[] | undefined
  let result: Awaited<ReturnType<typeof ctx.db.execute>>

  if (targetIds && targetIds.length > 0) {
    const docIds = targetIds.map((id) => `x:${id}`)
    const placeholders = docIds.map(() => "?").join(", ")
    result = await ctx.db.execute({
      sql: `SELECT id, doc FROM documents WHERE id IN (${placeholders})`,
      args: docIds,
    })
  } else {
    result = await ctx.db.execute({
      sql: `SELECT id, doc FROM documents
            WHERE json_extract(doc, '$.type') = 'x'
              AND json_extract(doc, '$.info.tags') IS NULL
              AND (json_extract(doc, '$.info.x_tag_job_fails') IS NULL
                   OR json_extract(doc, '$.info.x_tag_job_fails') < ?)
            LIMIT ?`,
      args: [MAX_FAILS, BATCH_SIZE],
    })
  }

  if (result.rows.length === 0) {
    ctx.log.info(targetIds ? "No matching tweets found" : "No untagged tweets to process")
    return { tagged: [], failed: [], total: 0 }
  }

  ctx.log.info(`Processing ${result.rows.length} tweets${targetIds ? " (targeted)" : ""}`)

  const systemPrompt = promptContent
  const taggedIds: string[] = []
  const failedIds: string[] = []
  let backlogChanged = false

  for (const row of result.rows) {
    const docId = String(row.id)
    const doc = JSON.parse(String(row.doc)) as Record<string, unknown>
    const text = String(doc.text ?? "")
    const screenshot = doc.screenshot as string | null

    const info = (doc.info as Record<string, unknown>) ?? {}
    const runCount = (typeof info.x_tag_job_run === "number" ? info.x_tag_job_run : 0) + 1

    try {
      const userContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = []
      userContent.push({ type: "text", text: `Tweet:\n${text}` })

      if (screenshot) {
        const imageUrl = screenshot.startsWith("data:")
          ? screenshot
          : `data:image/png;base64,${screenshot}`
        userContent.push({ type: "image_url", image_url: { url: imageUrl } })
      }

      const messages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ]

      const rawResponse = await callLmStudio(messages, endpoint, model)
      const result = parseTagResponse(rawResponse, tags, backlog)

      if (result.isBacklog && !backlog.includes(result.name) && !tags.includes(result.name)) {
        backlog = [result.name, ...backlog]
        backlogChanged = true
      }

      // Merge new tag with existing tags (deduplicated)
      const existingTags = Array.isArray(info.tags) ? (info.tags as string[]) : []
      const mergedTags = [...new Set([...existingTags, result.name])]
      const updatedInfo = { ...info, tags: mergedTags, x_tag_job_run: runCount }
      doc.info = updatedInfo

      await ctx.db.execute({
        sql: "UPDATE documents SET doc = json(?) WHERE id = ?",
        args: [JSON.stringify(doc), docId],
      })

      taggedIds.push(docId)
      ctx.log.info(`Tagged ${docId}: ${result.name}${result.isBacklog ? " (backlog)" : ""}`)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      ctx.log.error(`Failed to tag ${docId}: ${msg}`)

      const failCount =
        (typeof info.x_tag_job_fails === "number" ? info.x_tag_job_fails : 0) + 1
      const updatedInfo = { ...info, x_tag_job_run: runCount, x_tag_job_fails: failCount }
      doc.info = updatedInfo

      try {
        await ctx.db.execute({
          sql: "UPDATE documents SET doc = json(?) WHERE id = ?",
          args: [JSON.stringify(doc), docId],
        })
      } catch {
        ctx.log.error(`Failed to update fail count for ${docId}`)
      }

      failedIds.push(docId)
    }
  }

  if (backlogChanged) {
    const updated = writeTagSections(promptContent, tags, backlog)
    writeFileSync(promptPath, updated, "utf-8")
    ctx.log.info(`Updated prompt.md (backlog now ${backlog.length} entries)`)
  }

  ctx.log.info(`x_tag complete: ${taggedIds.length} tagged, ${failedIds.length} failed`)
  return { tagged: taggedIds, failed: failedIds, total: result.rows.length }
}

export default xTagJob
