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

## 4. Study & AI (flashcards, recall, quizzes, exams, lecture recording)

The Study view turns notes, PDFs, pasted captions and recorded lectures into
FSRS-scheduled flashcards, blank-page recall, quizzes and timed mock exams.
Model calls go through `functions/api/study/[action].js`:

- **Claude** (Anthropic API): Haiku 4.5 / Sonnet 5.5 / Opus 5.5.
- **Workers AI**: Whisper transcription, plus Llama 3.3 70B as a free option.

You can change the model for each study type in **Admin → Study & AI**.

### One-time setup

1. **Tables:** re-run the schema. It's safe to re-run; it adds `study_jobs` and `study_attempts`.

   ```
   npx wrangler d1 execute folio-db --remote --file=./schema.sql
   ```

2. **Workers AI binding:** nothing to do. It's declared in `wrangler.toml`
   (`[ai] binding = "AI"`), which manages this project's bindings, so it can't
   be added in the dashboard and is applied on the next deploy.

3. **Anthropic API key:** create one at console.anthropic.com and set a monthly
   spend limit there.

   ```powershell
   npx wrangler pages secret put ANTHROPIC_API_KEY --project-name folio
   ```

4. **Build command (required):** `@anthropic-ai/sdk` is a real dependency now, and
   Pages only installs dependencies as part of a build step. With no build
   command it logs *No build command specified. Skipping build step.*, installs
   nothing, and the deploy fails with `Could not resolve "@anthropic-ai/sdk"`.
   In *Dashboard → Workers & Pages → folio → Settings → Build configuration*, set
   **Build command** to `npm ci`, and leave the output directory as `.`. The next
   build log should show *Installing project dependencies*.

5. **Push notifications for finished batches (optional):**

   ```powershell
   npm install                      # at the repo root — the worker imports the SDK from ../node_modules
   cd push-worker
   npx wrangler secret put ANTHROPIC_API_KEY
   npx wrangler deploy
   cd ..
   ```

   Without this, batch results still arrive. They're imported the next time you
   open the Study view; you just don't get a notification.

6. **Microphone:** `_headers` now allows `microphone=(self)`. Recording only
   works after that deploy is live.

7. **Gemini key for automatic YouTube transcripts (optional, free):** create a key
   at aistudio.google.com (no card needed; the free tier allows 8 hours of
   YouTube video a day), then:

   ```powershell
   npx wrangler pages secret put GEMINI_API_KEY --project-name folio
   ```

   Only if you later enable billing on that key, also set `GEMINI_BILLING=paid`
   so Admin → Costs counts it — about $0.30 per hour of video at Oct 2026 prices.

8. **Check it:** go to *Admin → Study & AI → Test connection*. It makes one tiny
   Haiku call and one tiny Llama call.

### How it works, briefly

- **Batch vs live.** Batch (half price) suits flashcards, quizzes and smart notes,
  because they can wait a few minutes. Live suits exams and anything interactive.
  The defaults are Haiku in batch for everyday material, Sonnet live for exams
  and marking, and Llama for checking typed answers.
- **Results stay out of the state blob.** AI results never go into the `state`
  blob from the server. They sit in `study_jobs` until a device imports them,
  using deterministic ids so two devices can't duplicate cards. The import is
  then acked and the stored result dropped.
- **Recordings** are cut into ~4.5-minute segments. Each one is saved in
  IndexedDB until Whisper has transcribed it. The transcript goes to R2 as a
  `text/plain` attachment, because an hour is about 50 KB, too much for the blob.
- **Floating player.** Notes can carry media: a kept recording or a YouTube video.
  *Play* opens a draggable, resizable window (size and position are remembered per
  device) that keeps playing while you move around Folio. Its transcript follows
  along, and clicking a timestamp jumps to that moment.
- **Kept recordings.** With "Keep the audio" ticked (the default) each ~4.5-minute
  segment is also uploaded to R2 — about 15 MB per hour, well inside R2's free 10 GB.
  Playback stitches the segments into one timeline using each segment's *measured*
  audio length, so it stays accurate even if the phone paused capture mid-lecture.
  Deleting the note (or the recording) deletes the audio.
- **YouTube.** Videos play through YouTube's official embedded player, so
  `_headers` allows `youtube-nocookie.com` frames and `www.youtube.com` scripts
  (and `blob:` audio). Some videos — often music — can't be embedded; Folio
  remembers that and offers *Open ↗* instead.
- **YouTube transcripts.** YouTube no longer hands captions to servers (tested
  2026-10-02), so Folio has three routes, tried in this order:
  1. **Gemini (automatic, phone or desktop):** paste a link and Gemini transcribes
     the video — needs `GEMINI_API_KEY` (step 7). Public videos only; the text is
     AI-generated, so it's close but not guaranteed word-for-word. It runs as
     Gemini *background jobs* in 15-minute parts: the server only starts a job or
     checks on one (each a quick request), so no request can hit Cloudflare's
     ~100 s limit however long the video. Keep the page open while it works
     (roughly one to three minutes per part); if a part fails, pressing Look up
     again carries on from where it stopped.
  2. **"Send to Folio" bookmark (free, desktop):** shown under the paste box. Drag
     it to the bookmarks bar once; on any YouTube video, click it and Folio opens
     with YouTube's own captions filled in. It works because YouTube still serves
     captions to its own page — it briefly asks the player to load captions, then
     puts them back as they were. Nothing passes through a server.
  3. **Paste** (YouTube → …more → Show transcript → copy all) for anything else.
- **Spend:** *Admin → Study & AI → Show last 30 days* reports an estimate from
  logged token usage.

---

## Environment variables (Pages → Settings → Environment variables)

| Name | Notes |
|---|---|
| `SYNC_TOKEN` | Secret. Same value on every device you sync. Guards `/api/state`, `/api/push` and `/api/files`, and the push Worker's `/run`, `/test` and `/status`. |
| `ANTHROPIC_API_KEY` | Secret. Claude calls for Study (see section 4). Also set on the push Worker if you want batch-ready notifications. |
| `GEMINI_API_KEY` | Secret, optional. Automatic YouTube transcripts via Gemini's free tier (section 4, step 7). |
| `GEMINI_BILLING` | Optional. Set to `paid` only if the Gemini key has billing on, so Costs counts it. |

## After deploying

Bump `CACHE` in `sw.js` whenever static assets change, or clients keep serving
the old cached copy. Currently `folio-v44`.
