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
