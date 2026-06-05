/* ============================================================
   Folio · Second Brain — /api/state
   ------------------------------------------------------------
   Cloudflare Pages Function. Auto-routed to /api/state.

   Bindings (Pages → Settings → Environment variables):
     env.DB           D1 database binding  (binding name: DB)
     env.SYNC_TOKEN   Secret (encrypted environment variable)

   Endpoints:
     GET  /api/state  → returns stored state JSON (or {} on first run)
     PUT  /api/state  → replaces stored state JSON

   All requests require:
     Authorization: Bearer <SYNC_TOKEN>
   ============================================================ */

const MAX_BODY_BYTES = 5 * 1024 * 1024; /* 5 MB — notes with embedded images */

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });

/* Constant-time token comparison — prevents timing-based leaks */
const tokenOk = (request, env) => {
  const header = request.headers.get('Authorization') || '';
  const given  = header.replace(/^Bearer\s+/i, '').trim();
  const expect = env.SYNC_TOKEN || '';
  if (!given || !expect || given.length !== expect.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expect.charCodeAt(i);
  return diff === 0;
};

export async function onRequest({ request, env }) {
  if (!tokenOk(request, env)) return json({ error: 'Unauthorized' }, 401);

  try {
    if (request.method === 'GET') {
      const row = await env.DB.prepare(
        'SELECT data FROM state WHERE id = 1'
      ).first();
      if (!row || !row.data) return json({});
      try { return json(JSON.parse(row.data)); }
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

      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO state (id, data, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
      ).bind(JSON.stringify(body), now).run();
      return json({ ok: true, updated_at: now });
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch {
    return json({ error: 'Internal server error' }, 500);
  }
}
