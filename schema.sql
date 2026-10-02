-- Folio · Second Brain — D1 schema
-- Run once via Cloudflare dashboard: D1 → your database → Console
-- or via wrangler:
--   wrangler d1 execute folio-db --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS state (
  id          INTEGER PRIMARY KEY,
  data        TEXT    NOT NULL DEFAULT '{}',
  updated_at  INTEGER NOT NULL DEFAULT 0
);

-- Seed the single row so PUT can always UPSERT cleanly
INSERT OR IGNORE INTO state (id, data, updated_at) VALUES (1, '{}', 0);

-- `data` is the whole app state as one JSON blob, merged server-side on every
-- PUT (see functions/api/state.js) rather than overwritten, so two devices
-- editing at once can't clobber each other. Deletion is carried explicitly as
-- timestamped tombstones in the `<collection>Deleted` arrays, because absence
-- can't mean "deleted": a device that hasn't heard about an item yet pushes a
-- payload without it. Tombstones are garbage-collected after 90 days.
-- `updated_at` doubles as the ETag/optimistic-concurrency version, so it must
-- stay strictly increasing.

-- Web Push subscriptions (one row per device/browser)
CREATE TABLE IF NOT EXISTS push_subs (
  id           TEXT PRIMARY KEY,            -- push endpoint URL (stable per device/browser)
  subscription TEXT NOT NULL,               -- JSON: { endpoint, keys: { p256dh, auth } }
  schedule     TEXT NOT NULL DEFAULT '[]',  -- JSON: one-off entries only (pomodoro, test) — see below
  sent         TEXT NOT NULL DEFAULT '[]',  -- JSON: ids already delivered (or retired as stale)
  next_fire_at INTEGER NOT NULL DEFAULT 0,  -- unix ms of earliest undelivered entry (0 = none)
  updated_at   INTEGER NOT NULL             -- last time this sub was confirmed WORKING
);

-- MIGRATION — run once if this table predates the `sent` column:
--   ALTER TABLE push_subs ADD COLUMN sent TEXT NOT NULL DEFAULT '[]';

-- The recurring plan (meetings + salah) is NOT stored here. The cron Worker
-- re-derives it from the `state` row on every tick, so notifications keep
-- firing even if the app is never opened. `schedule` now holds only one-off
-- entries the client pushes that aren't derivable from state.
--
-- `sent` is what makes rebuilding safe: the plan is never consumed, so a
-- delayed or skipped cron tick can't permanently lose a notification, and a
-- rebuild can't resurrect a delivered one. Entries self-prune once their id
-- drops out of the plan (ids embed their date, so they never repeat).
--
-- `next_fire_at` is observability only. It must NEVER gate delivery: the
-- previous design filtered on it, so a row that drained to 0 stopped being
-- selected and went silent forever.
CREATE INDEX IF NOT EXISTS idx_push_subs_next_fire ON push_subs (next_fire_at);

-- ── Study (functions/api/study/[action].js) ──
-- AI results live here, never in the `state` blob: the client PUTs that blob
-- whole, so a server-side write into it would be overwritten. The client
-- imports finished results through its own update() and then acks them.
--
-- Batch jobs:  id = client-generated job id; status submitted → (ended) →
--              collecting → done | error → imported (result dropped on ack).
-- Live calls:  id = "<jobId>:<kind>:<chunk>" for generations (so a retried
--              request returns the stored result instead of paying twice),
--              or a random id for checks/marking; status done. Kept 35 days
--              so /api/study/usage can report spend.
CREATE TABLE IF NOT EXISTS study_jobs (
  id           TEXT PRIMARY KEY,
  set_id       TEXT,
  kinds        TEXT NOT NULL,              -- comma-separated: flashcards,quiz,exam,smartNotes,cardCheck,…
  model        TEXT NOT NULL,              -- comma-separated when a batch mixes models
  mode         TEXT NOT NULL,              -- 'live' | 'batch'
  batch_id     TEXT,                       -- Anthropic message batch id
  status       TEXT NOT NULL,
  request_meta TEXT NOT NULL DEFAULT '{}', -- JSON: { title, items:[{custom_id, kind, model, chunk}] }
  result       TEXT,                       -- JSON
  error        TEXT,
  usage        TEXT,                       -- JSON token counts (batch rows also carry byModel cost)
  notified     INTEGER NOT NULL DEFAULT 0, -- push sent by the push worker
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_study_jobs_status ON study_jobs (status);
CREATE INDEX IF NOT EXISTS idx_study_jobs_created ON study_jobs (created_at);

-- Exam attempts: written answers + marking are 5–15 KB each, too big to keep
-- in the synced blob. The study set itself only keeps the last 5 scores.
CREATE TABLE IF NOT EXISTS study_attempts (
  id         TEXT PRIMARY KEY,
  set_id     TEXT,
  exam_id    TEXT,
  data       TEXT NOT NULL,                -- JSON: { questions, results }
  score      REAL NOT NULL,
  max        REAL NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_study_attempts_exam ON study_attempts (exam_id);
