/* ============================================================
   Folio — /api/push
   ------------------------------------------------------------
   POST   /api/push  → upsert push subscription + notification schedule
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
