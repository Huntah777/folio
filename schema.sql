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

-- Web Push subscriptions + notification schedule (one row per device/browser)
CREATE TABLE IF NOT EXISTS push_subs (
  id           TEXT PRIMARY KEY,            -- push endpoint URL (stable per device/browser)
  subscription TEXT NOT NULL,               -- JSON: { endpoint, keys: { p256dh, auth } }
  schedule     TEXT NOT NULL DEFAULT '[]',  -- JSON: pending plan [{ id, title, body, fireAt }]
  next_fire_at INTEGER NOT NULL DEFAULT 0,  -- unix ms of earliest undelivered entry (0 = none)
  updated_at   INTEGER NOT NULL             -- last time this sub was confirmed working
);

-- next_fire_at is denormalised from `schedule` purely so the delivery worker can
-- find due subscriptions with an indexed lookup instead of parsing every plan.
CREATE INDEX IF NOT EXISTS idx_push_subs_next_fire ON push_subs (next_fire_at);
