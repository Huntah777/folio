// Folio background push worker
// Handles: POST /push (upsert subscription + schedule) + cron (send due notifications)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ─── base64url helpers ────────────────────────────────────────────────────────

function b64url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = str.length % 4;
  if (pad) str += '='.repeat(4 - pad);
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...bufs) {
  let len = 0;
  for (const b of bufs) len += b.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const b of bufs) { out.set(b, off); off += b.length; }
  return out;
}

// ─── HKDF (RFC 5869) ─────────────────────────────────────────────────────────

async function hkdfExtract(salt, ikm) {
  const key = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, ikm));
}

async function hkdfExpand(prk, info, len) {
  const key = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  let t = new Uint8Array(0), okm = new Uint8Array(0);
  for (let i = 1; i <= Math.ceil(len / 32); i++) {
    t = new Uint8Array(await crypto.subtle.sign('HMAC', key, concat(t, info, new Uint8Array([i]))));
    okm = concat(okm, t);
  }
  return okm.slice(0, len);
}

// ─── RFC 8291 Web Push content encryption ────────────────────────────────────

async function encryptWebPush(payload, subscription) {
  const receiverPub = b64urlDecode(subscription.keys.p256dh);
  const authSecret  = b64urlDecode(subscription.keys.auth);

  const ephemeral  = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const senderPub  = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  const receiverKey = await crypto.subtle.importKey('raw', receiverPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: receiverKey }, ephemeral.privateKey, 256));

  const enc  = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // RFC 8291 key derivation
  const prk     = await hkdfExtract(authSecret, sharedSecret);
  const ikm     = await hkdfExpand(prk, concat(enc.encode('WebPush: info\x00'), receiverPub, senderPub), 32);
  const prk2    = await hkdfExtract(salt, ikm);
  const cek     = await hkdfExpand(prk2, concat(enc.encode('Content-Encoding: aes128gcm\x00'), new Uint8Array([1])), 16);
  const nonce   = await hkdfExpand(prk2, concat(enc.encode('Content-Encoding: nonce\x00'), new Uint8Array([1])), 12);

  const plainBuf = enc.encode(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const cekKey   = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const cipher   = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, cekKey, concat(plainBuf, new Uint8Array([2])))
  );

  // aes128gcm body: salt(16) | rs(4,be) | keylen(1=65) | senderPub(65) | ciphertext
  const body = new Uint8Array(16 + 4 + 1 + 65 + cipher.length);
  body.set(salt, 0);
  new DataView(body.buffer).setUint32(16, 4096, false);
  body[20] = 65;
  body.set(senderPub, 21);
  body.set(cipher, 86);
  return body;
}

// ─── VAPID JWT + key import ───────────────────────────────────────────────────

let _vapidKey = null;

async function getVapidSignKey(env) {
  if (_vapidKey) return _vapidKey;
  const pub = b64urlDecode(env.VAPID_PUBLIC_KEY);
  _vapidKey = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC', crv: 'P-256',
      d: env.VAPID_PRIVATE_KEY,
      x: b64url(pub.slice(1, 33)),
      y: b64url(pub.slice(33, 65)),
      key_ops: ['sign'],
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  return _vapidKey;
}

async function vapidAuth(endpoint, env) {
  const url = new URL(endpoint);
  const aud = `${url.protocol}//${url.host}`;
  const e   = s => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const hdr = e(JSON.stringify({ alg: 'ES256', typ: 'JWT' }));
  const pld = e(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 43200, sub: env.VAPID_SUBJECT }));
  const inp = `${hdr}.${pld}`;
  const key = await getVapidSignKey(env);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(inp)));
  return `vapid t=${inp}.${b64url(sig)},k=${env.VAPID_PUBLIC_KEY}`;
}

// ─── Send one Web Push message ────────────────────────────────────────────────

async function sendPush(subscription, payload, env) {
  const body  = await encryptWebPush(JSON.stringify(payload), subscription);
  const auth  = await vapidAuth(subscription.endpoint, env);
  const res   = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization:    auth,
      'Content-Type':   'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      TTL:              '86400',
    },
    body,
  });
  return res.status;
}

// ─── Fetch handler: POST /push (legacy — browser now calls Pages Function /api/push) ──

async function handleFetch(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  return new Response('Use /api/push', { status: 410, headers: CORS });
}

// ─── Scheduled handler: fire due notifications ────────────────────────────────

async function handleScheduled(env) {
  const now       = Date.now();
  const lookback  = 90  * 1000;   // catch anything missed within 90 s
  const lookahead = 150 * 1000;   // 2.5 min window (cron every 2 min)

  // Index scan: only rows whose next notification falls in this window
  const { results } = await env.DB.prepare(
    'SELECT id, subscription, schedule FROM push_subs WHERE next_fire_at BETWEEN ? AND ?'
  ).bind(now - lookback, now + lookahead).all();

  if (!results.length) return;

  const writes = [];   // batched UPDATE / DELETE statements

  for (const row of results) {
    let subscription, schedule;
    try {
      subscription = JSON.parse(row.subscription);
      schedule     = JSON.parse(row.schedule);
    } catch { continue; }

    const due = schedule.filter(n => n.fireAt >= now - lookback && n.fireAt <= now + lookahead);
    if (!due.length) continue;

    const remaining  = schedule.filter(n => n.fireAt > now + lookahead);
    const nextFireAt = remaining.length ? Math.min(...remaining.map(n => n.fireAt)) : 0;

    let expired = false;
    for (const n of due) {
      try {
        const status = await sendPush(subscription, {
          title:  n.title,
          body:   n.body,
          id:     n.id,
          type:   n.type  ?? 'meeting',
          prayer: n.prayer ?? null,
        }, env);

        if (status === 410 || status === 404) {
          writes.push(env.DB.prepare('DELETE FROM push_subs WHERE id = ?').bind(row.id));
          expired = true;
          break;
        }
      } catch {}
    }

    if (!expired) {
      writes.push(
        env.DB.prepare('UPDATE push_subs SET schedule = ?, next_fire_at = ? WHERE id = ?')
          .bind(JSON.stringify(remaining), nextFireAt, row.id)
      );
    }
  }

  if (writes.length) await env.DB.batch(writes);
}

// ─── Entry points ─────────────────────────────────────────────────────────────

export default {
  fetch:     (req, env)       => handleFetch(req, env),
  scheduled: (event, env, ctx) => ctx.waitUntil(handleScheduled(env)),
};
