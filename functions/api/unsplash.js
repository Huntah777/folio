/* ============================================================
   Folio — /api/unsplash
   ------------------------------------------------------------
   GET  /api/unsplash?q=<query>       → proxied Unsplash photo search
   POST /api/unsplash {downloadLocation} → fires Unsplash's required
                                           "download" tracking ping

   The Unsplash Access Key never reaches the browser — every request
   is authenticated with the app's own SYNC_TOKEN instead, same as
   /api/state and /api/push.

   Bindings: env.UNSPLASH_ACCESS_KEY
   ============================================================ */

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
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
  if (!env.UNSPLASH_ACCESS_KEY) return json({ error: 'not_configured' });

  try {
    if (request.method === 'GET') {
      const q = new URL(request.url).searchParams.get('q') || '';
      if (!q.trim()) return json({ results: [] });

      const r = await fetch(
        `https://api.unsplash.com/search/photos?query=${encodeURIComponent(q)}&per_page=24`,
        { headers: { Authorization: `Client-ID ${env.UNSPLASH_ACCESS_KEY}` } },
      );
      if (!r.ok) return json({ error: `HTTP_${r.status}` }, 502);
      const data = await r.json();

      const results = (data.results || []).map(p => ({
        id: p.id,
        thumbUrl: p.urls?.small,
        fullUrl: p.urls?.regular,
        downloadLocation: p.links?.download_location,
        photographer: { name: p.user?.name, profileUrl: p.user?.links?.html },
      }));
      return json({ results });
    }

    if (request.method === 'POST') {
      const { downloadLocation } = await request.json();
      if (!downloadLocation) return json({ error: 'Missing downloadLocation' }, 400);
      const sep = downloadLocation.includes('?') ? '&' : '?';
      await fetch(`${downloadLocation}${sep}client_id=${env.UNSPLASH_ACCESS_KEY}`).catch(() => {});
      return json({ ok: true });
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (err) {
    return json({ error: String(err?.message || err) }, 500);
  }
}
