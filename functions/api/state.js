/* ============================================================
   Folio · Second Brain — /api/state
   ------------------------------------------------------------
   Cloudflare Pages Function. Auto-routed to /api/state.

   Bindings (Pages → Settings → Environment variables):
     env.DB           D1 database binding  (binding name: DB)
     env.SYNC_TOKEN   Secret (encrypted environment variable)

   Endpoints:
     GET  /api/state  → returns stored state JSON (or {} on first run)
                        Honours If-None-Match → 304 when unchanged.
     PUT  /api/state  → MERGES the incoming state into the stored state
                        (see mergeState) and stores the result.
                        Add ?return=merged to get the merged blob back.

   All requests require:
     Authorization: Bearer <SYNC_TOKEN>
   ============================================================ */

const MAX_BODY_BYTES     = 5 * 1024 * 1024; /* 5 MB — notes with embedded images */
const MAX_WRITE_ATTEMPTS = 3;               /* optimistic-concurrency retries */
const TOMBSTONE_TTL_MS   = 90 * 24 * 60 * 60 * 1000; /* 90 days */

/* Collections carrying soft-delete tombstones in a sibling `<key>Deleted` array.
   Must stay in step with SEED() in index.html. */
const TOMBSTONED = ['notes', 'tasks', 'meetings', 'journal'];

const json = (data, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });

/* Constant-time token comparison via HMAC. HMAC output is always 32 bytes
   regardless of input length, so the final XOR loop can't leak the expected
   token's length through timing the way a plain length check does. */
const tokenOk = async (request, env) => {
  const header = request.headers.get('Authorization') || '';
  const given  = header.replace(/^Bearer\s+/i, '').trim();
  const expect = env.SYNC_TOKEN || '';
  if (!given || !expect) return false;

  const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.sign('HMAC', key, enc.encode(given)),
    crypto.subtle.sign('HMAC', key, enc.encode(expect)),
  ]);
  const ua = new Uint8Array(a), ub = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
};

/* ── Merge logic ──────────────────────────────────────────────────
   Folio has no per-user accounts: a handful of personal devices share one
   SYNC_TOKEN and one state row. A PUT therefore never blindly overwrites —
   it merges with whatever is currently stored.

   This used to be a whole-blob replace, which meant the routine debounced
   save was a data-loss window: two devices editing different notes within
   the debounce interval would see whichever wrote last wipe the other's
   edit outright. The client still merges (mergeById in index.html) but only
   on load and on explicit sync, so the common path went unprotected.

   Deletion is always carried as an explicit timestamped tombstone. Absence
   is never read as a delete: a device that simply hasn't heard about an item
   yet pushes a payload without it, and that must not destroy another
   device's work.

   This deliberately mirrors mergeById() in index.html — same inputs, same
   tie-breaks — so client and server can never disagree about a merge. ── */

const stampOf   = (it) => Number(it?.updated ?? it?.created ?? 0) || 0;
const tombStamp = (t)  => Number(t?.deletedAt ?? 0) || 0;

/* Per-item last-write-wins across items and tombstones. For every id seen in
   any of the four inputs the LATEST timestamp wins: a newer edit beats an
   older tombstone (editing after an unaware device deleted it undeletes it —
   last-write-wins, not a bug), and a newer tombstone beats an older edit.
   On an exact tie the tombstone wins, because tombstones are considered last. */
function mergeTombstoned(existingItems, incomingItems, existingTombs, incomingTombs, now) {
  const winners = new Map();
  const consider = (id, ts, kind, value) => {
    if (id === undefined || id === null) return;
    const cur = winners.get(id);
    if (!cur || ts >= cur.ts) winners.set(id, { ts, kind, value });
  };
  for (const it of existingItems || []) consider(it?.id, stampOf(it), 'item', it);
  for (const it of incomingItems || []) consider(it?.id, stampOf(it), 'item', it);
  for (const t of existingTombs  || []) consider(t?.id, tombStamp(t), 'tomb', t);
  for (const t of incomingTombs  || []) consider(t?.id, tombStamp(t), 'tomb', t);

  const items = [], tombstones = [];
  for (const w of winners.values()) {
    if (w.kind === 'item') items.push(w.value);
    /* Expired tombstones are dropped on the assumption every device has long
       since seen them. A device offline longer than the TTL can resurrect an
       item — the standard trade-off for not keeping tombstones forever. */
    else if (now - tombStamp(w.value) <= TOMBSTONE_TTL_MS) tombstones.push(w.value);
  }
  return { items, tombstones };
}

/* Union by id, incoming winning a collision. Used for collections with no
   delete-tracking, where absence carries no meaning and dropping an entry
   another device still knows about would be pure loss. */
const unionById = (a, b) => {
  const byId = new Map();
  for (const x of a || []) if (x?.id !== undefined && x?.id !== null) byId.set(x.id, x);
  for (const x of b || []) if (x?.id !== undefined && x?.id !== null) byId.set(x.id, x);
  return [...byId.values()];
};

export function mergeState(existing, incoming, now = Date.now()) {
  /* Catch-all default for any key not handled explicitly below — notably
     kanbanCols, a small rarely-edited array with no per-item timestamps, for
     which whole-value last-write-wins is proportionate. */
  const out = { ...existing, ...incoming };

  for (const key of TOMBSTONED) {
    const tKey = key + 'Deleted';
    const { items, tombstones } = mergeTombstoned(
      existing[key], incoming[key], existing[tKey], incoming[tKey], now,
    );
    out[key]  = items;
    out[tKey] = tombstones;
  }

  /* folders: no tombstones, so keep both sides' entries. */
  out.folders = unionById(existing.folders, incoming.folders);

  /* tags: flat strings with no delete concept — union, matching the client. */
  out.tags = [...new Set([...(existing.tags || []), ...(incoming.tags || [])])];

  /* Shallow per-key merges, not whole-object swaps: a device pushing a partial
     or stale settings object (e.g. one recovered from a failed load) must not
     be able to wipe unrelated keys just because its own copy lacked them. */
  out.banners = { ...(existing.banners || {}), ...(incoming.banners || {}) };
  out.salah   = { ...(existing.salah   || {}), ...(incoming.salah   || {}) };
  out.ui      = { ...(existing.ui      || {}), ...(incoming.ui      || {}) };

  return out;
}

export async function onRequest({ request, env }) {
  if (!await tokenOk(request, env)) return json({ error: 'Unauthorized' }, 401);

  try {
    if (request.method === 'GET') {
      const row = await env.DB.prepare(
        'SELECT data, updated_at FROM state WHERE id = 1'
      ).first();
      if (!row || !row.data) return json({});

      /* Version the row so a foreground refresh on unchanged state costs one
         304 instead of re-downloading (and re-applying) the whole blob —
         which matters on a phone waking a PWA on mobile data. */
      const etag = `"v${row.updated_at ?? 0}"`;
      if (request.headers.get('If-None-Match') === etag) {
        return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'no-store' } });
      }
      try { return json(JSON.parse(row.data), 200, { ETag: etag }); }
      catch { return json({}); }
    }

    if (request.method === 'PUT') {
      const cl = request.headers.get('Content-Length');
      if (cl && Number(cl) > MAX_BODY_BYTES) return json({ error: 'Payload too large' }, 413);

      const raw = await request.text();
      if (raw.length > MAX_BODY_BYTES) return json({ error: 'Payload too large' }, 413);

      let body;
      try { body = JSON.parse(raw); }
      catch { return json({ error: 'Invalid JSON' }, 400); }

      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json({ error: 'Invalid JSON' }, 400);
      }

      /* The merged blob is only echoed back on request: a routine debounced
         save shouldn't pay to re-download several MB of notes-with-images it
         already has. The client asks for it on explicit/foreground syncs. */
      const wantMerged = new URL(request.url).searchParams.get('return') === 'merged';

      /* Read → merge → conditional write, retrying if another device wrote in
         between (optimistic concurrency). */
      for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
        const existingRow = await env.DB.prepare(
          'SELECT data, updated_at FROM state WHERE id = 1'
        ).first();

        let existingData = {};
        try { existingData = existingRow?.data ? JSON.parse(existingRow.data) : {}; } catch {}
        const existingUpdatedAt = existingRow?.updated_at ?? 0;

        const merged     = mergeState(existingData, body);
        const serialised = JSON.stringify(merged);
        if (serialised.length > MAX_BODY_BYTES) return json({ error: 'Payload too large' }, 413);

        /* Strictly monotonic: two writes inside the same millisecond would
           otherwise share an updated_at, and the ETag built from it would tell
           a client "unchanged" about state that did change. */
        const now = Math.max(Date.now(), existingUpdatedAt + 1);
        const ok  = () => json(
          { ok: true, updated_at: now, ...(wantMerged ? { data: merged } : {}) },
          200,
          { ETag: `"v${now}"` },
        );

        if (!existingRow) {
          /* Defensive only — schema.sql seeds this row on setup. */
          try {
            await env.DB.prepare(
              'INSERT INTO state (id, data, updated_at) VALUES (1, ?, ?)'
            ).bind(serialised, now).run();
            return ok();
          } catch {
            continue; /* someone inserted concurrently — retry as an update */
          }
        }

        const result = await env.DB.prepare(
          'UPDATE state SET data = ?, updated_at = ? WHERE id = 1 AND updated_at = ?'
        ).bind(serialised, now, existingUpdatedAt).run();

        if (result.meta.changes > 0) return ok();
        /* Another device wrote between our read and write — retry on a fresh read. */
      }

      return json({ error: 'Too many concurrent writes, please retry' }, 409);
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (err) {
    console.error('state handler error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
}
