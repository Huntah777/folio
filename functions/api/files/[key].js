/* ============================================================
   Folio · Second Brain — /api/files/:key  (fetch / delete)
   ------------------------------------------------------------
   Cloudflare Pages Function. Auto-routed to /api/files/:key.

   Endpoints:
     GET    /api/files/<key>  → streams the stored object
     DELETE /api/files/<key>  → removes it

   Requires: Authorization: Bearer <SYNC_TOKEN>

   Note the client fetches these with an Authorization header and turns the
   response into a blob: URL — an <iframe>/<embed> src cannot carry a header,
   so the bytes can't be referenced by URL directly.
   ============================================================ */

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });

const tokenOk = async (request, env) => {
  const header = request.headers.get('Authorization') || '';
  const given  = header.replace(/^Bearer\s+/i, '').trim();
  const expect = env.SYNC_TOKEN || '';
  if (!given || !expect) return false;
  const k = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.sign('HMAC', k, enc.encode(given)),
    crypto.subtle.sign('HMAC', k, enc.encode(expect)),
  ]);
  const ua = new Uint8Array(a), ub = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
};

/* Keys are minted server-side as f/<32 hex>. Re-validating that shape here
   stops a caller using this endpoint to probe arbitrary paths in the bucket. */
const KEY_RE = /^[0-9a-f]{32}$/;

export async function onRequest({ request, env, params }) {
  if (!await tokenOk(request, env)) return json({ error: 'Unauthorized' }, 401);
  if (!env.FILES) return json({ error: 'R2 not configured' }, 501);

  const raw = Array.isArray(params.key) ? params.key.join('/') : String(params.key || '');
  if (!KEY_RE.test(raw)) return json({ error: 'Not found' }, 404);
  const key = 'f/' + raw;

  try {
    if (request.method === 'GET') {
      const obj = await env.FILES.get(key);
      if (!obj) return json({ error: 'Not found' }, 404);

      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set('Content-Length', String(obj.size));
      headers.set('ETag', obj.httpEtag);
      headers.set('X-Content-Type-Options', 'nosniff');
      /* Private: this is personal content behind a shared token, and the
         response must never land in a shared cache. */
      headers.set('Cache-Control', 'private, no-store');
      /* Never let the browser render an upload as a top-level document. */
      headers.set('Content-Disposition', 'attachment');
      if (obj.customMetadata?.name) headers.set('X-File-Name', encodeURIComponent(obj.customMetadata.name));

      return new Response(obj.body, { headers });
    }

    if (request.method === 'DELETE') {
      await env.FILES.delete(key);
      return json({ ok: true });
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (err) {
    console.error('file handler error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
}
