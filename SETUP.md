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
not deployed by `git push`. It only needs redeploying if you change files under
`push-worker/`.

Note `push-worker/wrangler.toml` is gitignored, so it must exist locally
(with the D1 binding, cron trigger and VAPID secrets) before deploying:

```
cd push-worker && npx wrangler deploy
```

---

## Environment variables (Pages → Settings → Environment variables)

| Name | Notes |
|---|---|
| `SYNC_TOKEN` | Secret. Same value on every device you sync. Guards `/api/state`, `/api/push` and `/api/files`. |

## After deploying

Bump `CACHE` in `sw.js` whenever static assets change, or clients keep serving
the old cached copy. Currently `folio-v13`.
