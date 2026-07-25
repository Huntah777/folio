/* ============================================================
   Folio — /api/push
   ------------------------------------------------------------
   POST   /api/push  → upsert push subscription + notification schedule (full replace)
   PATCH  /api/push  → merge a single one-off notification (e.g. pomodoro)
                       into the existing schedule without rebuilding it —
                       avoids re-fetching prayer times for an unrelated change
   DELETE /api/push  → remove subscription (unsubscribe)

   Bindings: env.DB (D1), env.SYNC_TOKEN
   ============================================================ */

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

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
    if (request.method === 'POST') {
      const { subscription, schedule } = await request.json();
      if (!subscription?.endpoint) return json({ error: 'Missing subscription' }, 400);

      const arr = Array.isArray(schedule) ? schedule : [];
      const nextFireAt = arr.length ? Math.min(...arr.map(n => n.fireAt)) : 0;

      await env.DB.prepare(
        `INSERT INTO push_subs (id, subscription, schedule, next_fire_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE
           SET subscription  = excluded.subscription,
               schedule      = excluded.schedule,
               next_fire_at  = excluded.next_fire_at,
               updated_at    = excluded.updated_at`,
      ).bind(
        subscription.endpoint,
        JSON.stringify(subscription),
        JSON.stringify(arr),
        nextFireAt,
        Date.now(),
      ).run();

      return json({ ok: true });
    }

    if (request.method === 'PATCH') {
      const { subscription, notification } = await request.json();
      if (!subscription?.endpoint) return json({ error: 'Missing subscription' }, 400);
      const id = subscription.endpoint;

      // Optimistic-concurrency compare-and-swap: read the schedule, compute the merged
      // array in JS, then write it back only if nothing else touched the row since our
      // read (guarded by updated_at in the same statement, via SQLite's UPSERT
      // "ON CONFLICT ... WHERE" — the whole INSERT is a no-op if that WHERE is false).
      // Avoids the old SELECT-then-separate-UPSERT race where two concurrent PATCHes
      // (e.g. a pomodoro update and a meeting-notification update landing close
      // together) could silently drop one of the two schedule updates.
      for (let attempt = 0; attempt < 5; attempt++) {
        const row = await env.DB.prepare(
          'SELECT schedule, updated_at FROM push_subs WHERE id = ?'
        ).bind(id).first();

        let arr = [];
        if (row?.schedule) { try { arr = JSON.parse(row.schedule) || []; } catch {} }
        arr = arr.filter(n => n.id !== (notification?.id || 'pomodoro'));
        if (notification) arr.push(notification);

        const nextFireAt = arr.length ? Math.min(...arr.map(n => n.fireAt)) : 0;
        const prevUpdatedAt = row ? row.updated_at : -1; // irrelevant when there's no existing row to conflict with

        const result = await env.DB.prepare(
          `INSERT INTO push_subs (id, subscription, schedule, next_fire_at, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE
             SET subscription  = excluded.subscription,
                 schedule      = excluded.schedule,
                 next_fire_at  = excluded.next_fire_at,
                 updated_at    = excluded.updated_at
             WHERE push_subs.updated_at = ?`,
        ).bind(
          id,
          JSON.stringify(subscription),
          JSON.stringify(arr),
          nextFireAt,
          Date.now(),
          prevUpdatedAt,
        ).run();

        if (result.meta.changes > 0) return json({ ok: true });
        // else: another request updated this row between our SELECT and this write — retry with a fresh read
      }

      return json({ error: 'Conflict — too many concurrent updates, try again' }, 409);
    }

    if (request.method === 'DELETE') {
      const { endpoint } = await request.json();
      if (endpoint) await env.DB.prepare('DELETE FROM push_subs WHERE id = ?').bind(endpoint).run();
      return json({ ok: true });
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (err) {
    return json({ error: String(err?.message || err) }, 500);
  }
}
