/**
 * Document database using LibSQL.
 *
 * Three tables:
 * - documents: <id TEXT PRIMARY KEY, doc JSONB NOT NULL>
 * - collector_state: <key TEXT PRIMARY KEY, value TEXT NOT NULL>
 * - job_runs: <id TEXT PRIMARY KEY, job_id TEXT, trigger TEXT, status TEXT, started_at TEXT, finished_at TEXT, error TEXT, result TEXT>
 */

import { createClient, type Client } from "@libsql/client"
import { join } from "node:path"
import { getProfileDir } from "../config.js"
import { createLogger } from "../logger.js"

const log = createLogger("db")

export async function initDatabase(): Promise<Client> {
  const dbPath = join(getProfileDir(), "data.db")
  const db = createClient({ url: `file:${dbPath}` })

  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      doc JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS collector_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS job_runs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      error TEXT,
      result TEXT
    );
    CREATE TABLE IF NOT EXISTS articles (
      id TEXT PRIMARY KEY,
      source_key TEXT,
      collect_data TEXT NOT NULL,
      content TEXT NOT NULL,
      markdown TEXT NOT NULL DEFAULT '',
      media_data TEXT DEFAULT '[]',
      markdown_path TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_doc_type ON documents(json_extract(doc, '$.type'));
    CREATE INDEX IF NOT EXISTS idx_doc_collected_at ON documents(json_extract(doc, '$.collectedAt'));
    CREATE INDEX IF NOT EXISTS idx_doc_x_collected_at ON documents(json_extract(doc, '$.type'), json_extract(doc, '$.collectedAt'));
    CREATE INDEX IF NOT EXISTS idx_doc_x_tweet_at ON documents(json_extract(doc, '$.type'), json_extract(doc, '$.tweetAt'));
    CREATE INDEX IF NOT EXISTS idx_job_runs_job_started ON job_runs(job_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_articles_source_key ON articles(source_key);
    CREATE INDEX IF NOT EXISTS idx_articles_created_at ON articles(created_at DESC);
  `)

  log.info({ dbPath }, "Database initialized")
  return db
}
