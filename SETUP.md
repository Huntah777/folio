# Folio — deployment & setup

Everything except the two steps below deploys automatically when you
`git push` (Cloudflare Pages builds from the repo; there is no build step).

---

## 1. D1 — app state

Already set up. The `state` table holds the whole app as one JSON blob, merged
server-side on every PUT (see `functions/api/state.js`).

To (re)apply the schema — safe to re-run, everything is `IF NOT EXISTS`:

```
npx wrangler d1 execute folio-db --remote --file=./schema.sql
```

## 2. R2 — PDF attachments

PDFs are **not** stored in D1. The state blob is capped at 5 MB for the entire
app, so a single base64'd PDF would exhaust it. Binary files live in R2 and the
note keeps only a small `{ id, key, name, size, type }` record.

**One-time setup:**

```
npx wrangler r2 bucket create folio-files
```

Then bind it to the Pages project:

*Cloudflare Dashboard → Workers & Pages → folio → Settings → Bindings →
Add → R2 bucket*

| Field | Value |
|---|---|
| Variable name | `FILES` |
| R2 bucket | `folio-files` |

The binding is also declared in `wrangler.toml`. Add it for **Production**
(and Preview, if you use preview deployments).

Until the bucket is bound, PDF upload returns HTTP 501 and the UI says
*"PDF storage not set up yet"*. Nothing else is affected.

**Cost:** R2's free tier is 10 GB storage, 1M writes and 10M reads per month,
with no egress charges ever. Beyond that it's $0.015/GB-month. For personal use
this is effectively free.

## 3. Push notifications (separate Worker)

`push-worker/` is a **separate** Cloudflare Worker with a cron trigger — it is
**not** deployed by `git push`. Redeploy it whenever files under `push-worker/`
change.

### How it works

The Worker re-derives the whole notification plan (meetings + salah) from the
shared D1 `state` row **on every tick**, and tracks what it has already
delivered in `push_subs.sent`. The app does not need to be open — or ever
opened again — for notifications to keep arriving on every device.

This replaced a design where the client computed a 14-day schedule, POSTed it,
and the Worker drained it as it sent. That went permanently silent whenever the
app wasn't opened for a while: the stored schedule emptied, `next_fire_at`
reached 0, and the row stopped being selected at all.

### Required migration

The `sent` column is new. Run once from the repo root — re-running is harmless,
it just errors with "duplicate column name: sent":

```powershell
npx wrangler d1 execute folio-db --remote --command "ALTER TABLE push_subs ADD COLUMN sent TEXT NOT NULL DEFAULT '[]'"
```

### Deploy

`push-worker/wrangler.toml` is gitignored, so it must exist locally first. It
needs the D1 binding, a **once-a-minute** cron trigger, and the secrets below:

```toml
name = "folio-push"
main = "src/index.js"
compatibility_date = "2025-01-01"

[triggers]
crons = ["* * * * *"]

[[d1_databases]]
binding = "DB"
database_name = "folio-db"
database_id = "c0d1bd3a-e24b-4e8b-af38-b69028465b57"
```

```powershell
cd push-worker
npx wrangler secret put VAPID_PRIVATE_KEY   # base64url P-256 private scalar
npx wrangler secret put VAPID_SUBJECT       # mailto:you@example.com
npx wrangler secret put SYNC_TOKEN          # same value as the Pages project
npx wrangler deploy
cd ..
```

Windows PowerShell 5.1 has no `&&` operator — chain with `;` and `if ($?)`
(e.g. `cd push-worker; if ($?) { npx wrangler deploy }`) rather than
`cd push-worker && npx wrangler deploy`, which is a parser error.

### Verifying it works

The Worker exposes three token-guarded endpoints, so a silent pipeline can be
diagnosed without waiting for a real reminder to come due.

**PowerShell** (note: `curl` is an alias for `Invoke-WebRequest` here and does
not accept `-H`, so use `Invoke-RestMethod`):

```powershell
$t = "<your SYNC_TOKEN>"
$w = "https://<worker>.workers.dev"
$h = @{ Authorization = "Bearer $t" }

# What does the server think is scheduled, and which devices are registered?
Invoke-RestMethod -Uri "$w/status" -Headers $h | ConvertTo-Json -Depth 5

# Force a delivery tick right now
Invoke-RestMethod -Uri "$w/run" -Method POST -Headers $h | ConvertTo-Json -Depth 5

# Send an immediate test notification to every registered device
Invoke-RestMethod -Uri "$w/test" -Method POST -Headers $h | ConvertTo-Json -Depth 5
```

**bash / macOS / Linux:**

```bash
curl -H "Authorization: Bearer $SYNC_TOKEN" https://<worker>.workers.dev/status
curl -X POST -H "Authorization: Bearer $SYNC_TOKEN" https://<worker>.workers.dev/run
curl -X POST -H "Authorization: Bearer $SYNC_TOKEN" https://<worker>.workers.dev/test
```

`/test` returns the HTTP status per device. A `201`/`200` means the push service
accepted it; `404`/`410` means that subscription is dead and it is deleted
automatically. If `/status` shows `devices: []`, no device has registered —
open the app, grant notification permission, then use **Reconnect** in the
sync/setup modal.

Live logs: `npx wrangler tail` from `push-worker/`.

## 4. Videos and recordings in notes

Nothing to set up — this works with the D1 and R2 steps above.

- **Floating player.** Notes can carry media: a YouTube video or a lecture
  recording kept earlier. *Play* opens a draggable, resizable window (size and
  position are remembered per device) that keeps playing while you move around
  Folio. Its transcript follows along, and clicking a timestamp jumps to that
  moment.
- **Kept recordings.** Recordings made before the recorder was removed are
  stored in R2 as ~4.5-minute segments and played back as one timeline, using
  each segment's *measured* audio length. Deleting the note (or the recording)
  deletes the audio. There is no way to record new ones any more.
- **YouTube.** Videos play through YouTube's official embedded player, so
  `_headers` allows `youtube-nocookie.com` frames and `www.youtube.com` scripts
  (and `blob:` audio). Some videos — often music — can't be embedded; Folio
  remembers that and offers *Open ↗* instead.
- **YouTube transcripts.** YouTube no longer hands captions to servers (tested
  2026-10-02). Pasting a link still looks up the title, channel and whether the
  owner allows embedding (`/api/youtube`), and picks up captions if YouTube ever
  hands them over. For the transcript itself there are two routes:
  1. **"Send to Folio" bookmark (free, desktop):** shown under the paste box. Drag
     it to the bookmarks bar once; on any YouTube video, click it and Folio opens
     with YouTube's own captions filled in — as a new note with the video ready to
     play. It works because YouTube still serves captions to its own page: it
     briefly asks the player to load captions, then puts them back as they were.
     Nothing passes through a server.
  2. **Paste** (YouTube → …more → Show transcript → copy all) for anything else.

### If this Folio used to have the AI features

They were removed (flashcards, quizzes, exams, lecture recording and the
Claude / Gemini / Workers AI calls behind them). Nothing breaks if you leave the
old setup in place, but you can tidy it up:

```
# the two tables the old Study feature used (optional; they're empty weight now)
npx wrangler d1 execute folio-db --remote --command "DROP TABLE IF EXISTS study_jobs; DROP TABLE IF EXISTS study_attempts;"
```

- Delete the `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` and `GEMINI_BILLING` secrets
  from the Pages project, and `ANTHROPIC_API_KEY` from the push Worker.
- The Pages **Build command** (`npm ci`) was only there to install the Anthropic
  SDK. It can go back to empty, with the output directory still `.`.
- Cards and study sets already saved in your synced data are ignored, not deleted.

---

## Environment variables (Pages → Settings → Environment variables)

| Name | Notes |
|---|---|
| `SYNC_TOKEN` | Secret. Same value on every device you sync. Guards `/api/state`, `/api/push`, `/api/files` and `/api/youtube`, and the push Worker's `/run`, `/test` and `/status`. |

## After deploying

Bump `CACHE` in `sw.js` whenever static assets change, or clients keep serving
the old cached copy. Currently `folio-v50`.
