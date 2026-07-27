/* ============================================================
   Folio · Second Brain — /api/files  (upload)
   ------------------------------------------------------------
   Cloudflare Pages Function. Auto-routed to /api/files.

   Bindings (Pages → Settings):
     env.FILES        R2 bucket binding  (binding name: FILES)
     env.SYNC_TOKEN   Secret (encrypted environment variable)

   Endpoint:
     POST /api/files  → stores the raw request body as an object,
                        returns { key, name, size, type }

   Binary attachments deliberately do NOT live in the synced state blob.
   That blob is capped at 5 MB for the WHOLE app (every note, task and
   embedded image), so a single base64'd PDF would exhaust it. Notes store
   only the small metadata record this returns; the bytes stay in R2.

   Requires: Authorization: Bearer <SYNC_TOKEN>
   ============================================================ */

const MAX_FILE_BYTES = 25 * 1024 * 1024; /* 25 MB per file */

/* Deliberately narrow. Anything reachable by a note is served back to a
   browser, so an open upload endpoint on a shared token is an XSS vector
   (an uploaded .html would run on this origin). PDFs only for now. */
const ALLOWED_TYPES = new Set(['application/pdf']);

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });

/* Constant-time comparison via HMAC — see functions/api/state.js. */
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

/* Opaque, unguessable key. The original filename is kept as metadata rather
   than used as the key, so it can't shape the object path. */
const newKey = () => {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return 'f/' + [...b].map(x => x.toString(16).padStart(2, '0')).join('');
};

/* Strip anything that could confuse a Content-Disposition header or a
   filesystem when the user later downloads the file. */
const safeName = (raw) => {
  const cleaned = String(raw || 'document.pdf')
    .replace(/[\r\n"\\]/g, '')
    .replace(/[/\\]/g, '_')
    .trim();
  return (cleaned.slice(0, 200)) || 'document.pdf';
};

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!await tokenOk(request, env)) return json({ error: 'Unauthorized' }, 401);
  if (!env.FILES) {
    return json({ error: 'R2 not configured — add an R2 bucket bound as FILES in Pages → Settings → Bindings' }, 501);
  }

  try {
    const type = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_TYPES.has(type)) return json({ error: `Unsupported file type: ${type || 'unknown'}` }, 415);

    const declared = Number(request.headers.get('Content-Length') || 0);
    if (declared > MAX_FILE_BYTES) return json({ error: 'File too large (max 25 MB)' }, 413);

    const name = safeName(decodeURIComponent(request.headers.get('X-File-Name') || ''));

    /* Buffer so the real size can be enforced — Content-Length is a claim, and
       a streamed put() would otherwise commit an oversized object to R2. */
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength === 0) return json({ error: 'Empty file' }, 400);
    if (bytes.byteLength > MAX_FILE_BYTES) return json({ error: 'File too large (max 25 MB)' }, 413);

    const key = newKey();
    await env.FILES.put(key, bytes, {
      httpMetadata: { contentType: type },
      customMetadata: { name, uploadedAt: String(Date.now()) },
    });

    return json({ key, name, size: bytes.byteLength, type });
  } catch (err) {
    console.error('file upload error:', err);
    return json({ error: 'Upload failed' }, 500);
  }
}
