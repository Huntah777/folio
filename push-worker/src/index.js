// Folio — Web Push cron worker
// Required secret: VAPID_PRIVATE_KEY (wrangler secret put VAPID_PRIVATE_KEY)
// Required D1 binding: DB

const VAPID_PUBLIC_KEY = 'BMg79Dc4KgbVAa253omi5oER5VpB3ErcDnjaR5lgmIinGMVlUpe4-LUgfuQrTb9a3urAaLnDZgQ_vtE4OvVLcPA';
const VAPID_PUBLIC_X   = 'yDv0NzgqBtUBrbneiaLmgRHlWkHcStwOeNpHmWCYiKc';
const VAPID_PUBLIC_Y   = 'GMVlUpe4-LUgfuQrTb9a3urAaLnDZgQ_vtE4OvVLcPA';
const VAPID_SUBJECT    = 'mailto:abdul-malik@huntah.co.uk';

// ─── helpers ──────────────────────────────────────────────────────────────────

function fromB64u(s) {
  return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}

function toB64u(buf) {
  return btoa(Array.from(new Uint8Array(buf), c => String.fromCharCode(c)).join(''))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const a of arrays) { out.set(a, pos); pos += a.length; }
  return out;
}

const te = s => new TextEncoder().encode(s);

// HKDF-SHA-256 extract + single expand block (length ≤ 32)
async function hkdf(salt, ikm, info, length) {
  const saltKey = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const prk     = new Uint8Array(await crypto.subtle.sign('HMAC', saltKey, ikm));
  const prkKey  = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const okm     = new Uint8Array(await crypto.subtle.sign('HMAC', prkKey, concat(info, new Uint8Array([1]))));
  return okm.slice(0, length);
}

// ─── RFC 8291 aes128gcm encryption ────────────────────────────────────────────

async function encryptWebPush(plaintext, subscription) {
  const receiverPub = fromB64u(subscription.keys.p256dh);
  const authSecret  = fromB64u(subscription.keys.auth);

  const receiverKey = await crypto.subtle.importKey(
    'raw', receiverPub, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );

  const senderKP  = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const senderPub = new Uint8Array(await crypto.subtle.exportKey('raw', senderKP.publicKey));

  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: receiverKey }, senderKP.privateKey, 256,
  ));

  const salt  = crypto.getRandomValues(new Uint8Array(16));
  const ikm   = await hkdf(authSecret, ecdhSecret, concat(te('WebPush: info\x00'), receiverPub, senderPub), 32);
  const cek   = await hkdf(salt, ikm, te('Content-Encoding: aes128gcm\x00'), 16);
  const nonce = await hkdf(salt, ikm, te('Content-Encoding: nonce\x00'), 12);

  const cekKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const msg    = concat(te(plaintext), new Uint8Array([0x02]));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cekKey, msg));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  return concat(salt, rs, new Uint8Array([senderPub.length]), senderPub, cipher);
}

// ─── VAPID JWT ─────────────────────────────────────────────────────────────────

async function makeVapidJWT(endpoint, privateKeyB64u) {
  const audience  = new URL(endpoint).origin;
  const hdr = toB64u(te(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const pay = toB64u(te(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 43200, sub: VAPID_SUBJECT })));
  const unsigned = `${hdr}.${pay}`;

  const key = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256',
    d: privateKeyB64u, x: VAPID_PUBLIC_X, y: VAPID_PUBLIC_Y,
    key_ops: ['sign'], ext: true,
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);

  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te(unsigned)));
  return `${unsigned}.${toB64u(sig)}`;
}

// ─── Send one Web Push ────────────────────────────────────────────────────────

async function sendPush(subscription, payload, privateKeyB64u) {
  const jwt  = await makeVapidJWT(subscription.endpoint, privateKeyB64u);
  const body = await encryptWebPush(JSON.stringify(payload), subscription);

  const r = await fetch(subscription.endpoint, {
    method:  'POST',
    headers: {
      'Authorization':    `vapid t=${jwt},k=${VAPID_PUBLIC_KEY}`,
      'Content-Type':     'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL':              '86400',
      'Urgency':          'high',
    },
    body,
  });
  return r.status;
}

// ─── Scheduled handler ────────────────────────────────────────────────────────

async function handleScheduled(env) {
  const now      = Date.now();
  const lookBack = 90_000;

  const { results } = await env.DB.prepare(
    'SELECT id, subscription, schedule FROM push_subs WHERE next_fire_at > 0 AND next_fire_at <= ?'
  ).bind(now + 30_000).all();

  if (!results.length) return;

  const writes = [];

  await Promise.all(results.map(async row => {
    try {
      const sub      = JSON.parse(row.subscription);
      const schedule = JSON.parse(row.schedule || '[]');

      const due    = schedule.filter(n => n.fireAt >= now - lookBack && n.fireAt <= now + 30_000);
      const remain = schedule.filter(n => !due.some(d => d.id === n.id));

      if (!due.length) return;

      let expired = false;

      await Promise.all(due.map(async n => {
        if (expired) return;
        const status = await sendPush(sub, {
          title:  n.title,
          body:   n.body || '',
          id:     n.id,
          type:   n.type   ?? 'meeting',
          prayer: n.prayer ?? null,
        }, env.VAPID_PRIVATE_KEY);

        console.log(`push → ${row.id} [${n.title}] → HTTP ${status}`);

        if (status === 410 || status === 404) {
          writes.push(env.DB.prepare('DELETE FROM push_subs WHERE id = ?').bind(row.id));
          expired = true;
        }
      }));

      if (!expired) {
        const nextFireAt = remain.length ? Math.min(...remain.map(n => n.fireAt)) : 0;
        writes.push(
          env.DB.prepare('UPDATE push_subs SET schedule = ?, next_fire_at = ? WHERE id = ?')
            .bind(JSON.stringify(remain), nextFireAt, row.id)
        );
      }
    } catch (e) {
      console.error(`push error for ${row.id}:`, e.message);
    }
  }));

  if (writes.length) await env.DB.batch(writes);
}

// ─── Entry points ─────────────────────────────────────────────────────────────

export default {
  fetch:     () => new Response('Folio Push Worker', { status: 200 }),
  scheduled: (_event, env, ctx) => ctx.waitUntil(handleScheduled(env)),
};
