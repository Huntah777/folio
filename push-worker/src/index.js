/**
 * Folio — Web Push Cron Worker
 *
 * ONE Cron Trigger drives this Worker — every minute:
 *
 *   crons = ["* * * * *"]
 *
 * Every tick is a single idempotent pass:
 *   1. Re-derive the notification plan (meetings + salah) from the shared D1
 *      state row, for today and tomorrow in the user's timezone.
 *   2. Send anything now due that this device has not already been sent.
 *
 * Design notes — why it looks like this:
 *   · The plan is rebuilt from scratch every tick and is NEVER consumed.
 *     Delivery is tracked separately in the `sent` column.
 *
 *     This is the whole point of the rewrite. The previous version had the
 *     client compute a 14-day schedule, POST it, and the Worker drain it as it
 *     sent — then skip any row whose `next_fire_at` had reached 0. For a PWA
 *     that isn't opened daily that is a silent death: the schedule empties,
 *     `next_fire_at` goes to 0, the row stops being selected, and nothing ever
 *     fires again until the app happens to be opened and foregrounded. Now the
 *     server owns the plan and the client never has to be running at all.
 *
 *   · Every row is scanned every tick — deliberately no `next_fire_at` filter.
 *     That column is still maintained for observability, but never gates
 *     delivery, because a row that gates itself out can never recover.
 *
 *   · Notification ids embed the date (meeting-<id>-<YYYY-MM-DD>-<lead>), so
 *     they are globally unique rather than repeating daily. That lets `sent`
 *     self-prune by plan membership instead of resetting at local midnight,
 *     which removes a whole class of midnight-boundary double-send bugs.
 *
 *   · The plan covers today AND tomorrow, so a 15-minute lead on a 00:05
 *     meeting (which fires at 23:50 *today*) is scheduled while it is still in
 *     the future rather than being born stale.
 *
 *   · Cloudflare cron triggers are best-effort and routinely drift. A
 *     notification that came due while ticks were delayed is still sent, late,
 *     up to staleAfter(id). Past that it is retired unsent — a three-hours-late
 *     "starting in 5 min" is worse than none.
 *
 * Required secrets (wrangler secret put):
 *   VAPID_PRIVATE_KEY  — base64url P-256 private scalar
 *   VAPID_SUBJECT      — mailto: contact URI (e.g. mailto:you@example.com)
 *   SYNC_TOKEN         — same value as the Pages project; guards POST /run and /test
 *
 * Required D1 binding: DB (same database as the Pages project)
 */

const VAPID_PUBLIC_KEY = 'BMg79Dc4KgbVAa253omi5oER5VpB3ErcDnjaR5lgmIinGMVlUpe4-LUgfuQrTb9a3urAaLnDZgQ_vtE4OvVLcPA';
const VAPID_PUBLIC_X   = 'yDv0NzgqBtUBrbneiaLmgRHlWkHcStwOeNpHmWCYiKc';
const VAPID_PUBLIC_Y   = 'GMVlUpe4-LUgfuQrTb9a3urAaLnDZgQ_vtE4OvVLcPA';

/* How late a notification may still be delivered before it is retired as
   stale. Split by kind, because "too late to be useful" is not one number:
   a prayer time or a "starting in 5 min" warning is worse than useless once
   the moment has passed, but an at-time meeting alert is still informative a
   little later. Sized to absorb several consecutive missed cron ticks. */
const URGENT_LATE_MS  = 10 * 60_000;
const RELAXED_LATE_MS = 60 * 60_000;

const isUrgent = (id) => /-(?:15|5)$/.test(id) || id.startsWith('salah-');
export const staleAfter = (id) => (isUrgent(id) ? URGENT_LATE_MS : RELAXED_LATE_MS);

/* A notification due within this window is sent on this tick rather than
   waiting for the next one — keeps sub-minute accuracy despite a 1-min cron. */
const LOOK_AHEAD_MS = 30_000;

const parseJson = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

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

/* Constant-time compare via HMAC — output is fixed-width regardless of input,
   so the XOR loop can't leak the expected token's length through timing. */
async function tokenOk(given, expect) {
  if (!given || !expect) return false;
  const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const [a, b] = await Promise.all([
    crypto.subtle.sign('HMAC', key, te(given)),
    crypto.subtle.sign('HMAC', key, te(expect)),
  ]);
  const ua = new Uint8Array(a), ub = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
}

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

async function makeVapidJWT(endpoint, privateKeyB64u, subject) {
  const audience  = new URL(endpoint).origin;
  const hdr = toB64u(te(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const pay = toB64u(te(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 43200, sub: subject })));
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

async function sendPush(subscription, payload, privateKeyB64u, subject, ttlMs = 86_400_000) {
  const jwt  = await makeVapidJWT(subscription.endpoint, privateKeyB64u, subject);
  const body = await encryptWebPush(JSON.stringify(payload), subscription);

  const r = await fetch(subscription.endpoint, {
    method:  'POST',
    headers: {
      'Authorization':    `vapid t=${jwt},k=${VAPID_PUBLIC_KEY}`,
      'Content-Type':     'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      /* Don't let the push service hold a reminder longer than it stays
         useful — a device offline all day shouldn't be buzzed at midnight
         with this morning's alerts when it reconnects. */
      'TTL':              String(Math.max(60, Math.round(ttlMs / 1000))),
      'Urgency':          'high',
    },
    body,
  });
  return r.status;
}

// ─── Timezone helpers (a Worker has no implicit local timezone) ───────────────
/* Standard "double-format" technique: derive the UTC offset for a given
   instant by re-formatting it in the target IANA zone. DST-correct because it
   re-derives the offset from the actual date in question each time. */

const DEFAULT_TZ = 'Europe/London';

function tzOffsetMs(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map(x => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - date.getTime();
}

/* Calendar parts for "now" in tz, plus the same for tomorrow. */
function zonedParts(tz, dayOffset = 0) {
  const base = new Date(Date.now() + dayOffset * 86_400_000);
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
  const p = Object.fromEntries(dtf.formatToParts(base).map(x => [x.type, x.value]));
  const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { y: +p.year, mo: +p.month, d: +p.day, dow: WD[p.weekday], key: `${p.year}-${p.month}-${p.day}` };
}

/* "HH:MM on y-mo-d in tz" → UTC epoch ms */
function zonedHmToUtcMs(y, mo, d, hh, mm, tz) {
  const guess = Date.UTC(y, mo - 1, d, hh, mm, 0);
  return guess - tzOffsetMs(new Date(guess), tz);
}

// ─── Server-side replica of index.html's buildSchedule ────────────────────────
/* These mirrors must agree with index.html: the notification has to land on
   the same minute the app displays, and the ids must match so a locally
   scheduled alert and a pushed one dedupe by tag instead of double-buzzing. */

const SALAH_METHOD_IDS = { mwl: 3, isna: 2, egypt: 5, makkah: 4, karachi: 1, tehran: 7 };
const PRAYER_NAMES  = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];
const PRAYER_LABELS = { fajr: 'Fajr', sunrise: 'Sunrise (Shuruq)', dhuhr: 'Dhuhr', asr: 'Asr', maghrib: 'Maghrib', isha: 'Isha' };
const ALADHAN_KEY   = { fajr: 'Fajr', sunrise: 'Sunrise', dhuhr: 'Dhuhr', asr: 'Asr', maghrib: 'Maghrib', isha: 'Isha' };
const SALAH_OFFSET_LIMIT = 60;

export function salahOffsets(salah) {
  const out = {};
  for (const p of PRAYER_NAMES) {
    const v = Number(salah?.offsets?.[p]);
    out[p] = Number.isFinite(v) ? Math.max(-SALAH_OFFSET_LIMIT, Math.min(SALAH_OFFSET_LIMIT, Math.round(v))) : 0;
  }
  return out;
}

/* "HH:MM (TZ)" → minutes from midnight with the offset applied, clamped into
   the day so a nudge can never move a prayer onto the wrong date. */
export function salahMinutes(raw, offsetMin) {
  if (!raw) return null;
  const [hh, mm] = String(raw).split(' ')[0].split(':').map(Number);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  return Math.max(0, Math.min(24 * 60 - 1, hh * 60 + mm + (Number(offsetMin) || 0)));
}

const pad2 = n => String(n).padStart(2, '0');

/* Mirrors occursOnDay() in index.html. */
export function occursOnDay(m, parts) {
  const key = parts.key;
  if (m.exceptionDate) return m.exceptionDate === key;
  if (key < m.date) return false;
  if (m.recurrenceEnd && key > m.recurrenceEnd) return false;
  if ((m.exceptions || []).includes(key)) return false;
  if (m.date === key) return true;
  const r = m.recurrence || 'none';
  if (r === 'none')   return false;
  if (r === 'daily')  return true;
  if (r === 'weekly') return (m.recurrenceDays || []).includes(parts.dow);
  if (r === 'monthly') {
    const targetDay = Number(String(m.date).split('-')[2]);
    const daysInMonth = new Date(Date.UTC(parts.y, parts.mo, 0)).getUTCDate();
    return parts.d === Math.min(targetDay, daysInMonth);
  }
  return false;
}

/* Cached per (date, location, method, school) at the edge — a timetable for a
   given day never changes, so this is roughly one origin hit per day rather
   than one per cron tick. */
async function fetchSalahDay(salah, parts) {
  const method = SALAH_METHOD_IDS[salah.method] ?? 3;
  const school = salah.asr === 'hanafi' ? 1 : 0;
  const r = await fetch(
    `https://api.aladhan.com/v1/timings/${pad2(parts.d)}-${pad2(parts.mo)}-${parts.y}` +
    `?latitude=${salah.lat}&longitude=${salah.lng}&method=${method}&school=${school}`,
    { cf: { cacheTtl: 21600, cacheEverything: true } },
  );
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json())?.data?.timings || {};
}

/* Builds the FULL plan for the given days — entries already in the past are
   included, because the caller decides what is too stale to send. Pure
   function of (state, tz, days), so it can be recomputed every tick and
   compared or replaced safely. What has actually been delivered lives in
   push_subs.sent, never in here. */
export async function buildSchedule(state, tz, days) {
  const schedule = [];
  if (!state) return { schedule, ok: true };

  const LEADS = [[15, '15 min'], [5, '5 min']];
  const events = [];

  /* Meetings — same recurrence rules as the calendar view. */
  for (const parts of days) {
    for (const m of state.meetings || []) {
      if (!occursOnDay(m, parts)) continue;
      const [hh, mm] = String(m.time || '00:00').split(':').map(Number);
      if (!Number.isFinite(hh) || !Number.isFinite(mm)) continue;
      events.push({
        id: `meeting-${m.id}-${parts.key}`,
        title: m.title || 'Meeting',
        sub: m.attendees || '',
        at: zonedHmToUtcMs(parts.y, parts.mo, parts.d, hh, mm, tz),
        type: 'meeting',
      });
    }
  }

  /* Salah — a prayer-time fetch failure is NOT the same as "not configured".
     Signal it distinctly (ok:false) so the caller can skip this tick rather
     than deliver from a plan that is silently missing every prayer. */
  const salah = state.salah;
  let salahOk = true;
  if (salah?.enabled && salah.lat != null && salah.lng != null) {
    const offsets = salahOffsets(salah);
    for (const parts of days) {
      try {
        const timings = await fetchSalahDay(salah, parts);
        for (const p of PRAYER_NAMES) {
          if (salah.prayers?.[p] === false) continue;
          const mins = salahMinutes(timings[ALADHAN_KEY[p]], offsets[p]);
          if (mins == null) continue;
          events.push({
            id: `salah-${p}-${parts.key}`,
            title: PRAYER_LABELS[p],
            sub: '',
            at: zonedHmToUtcMs(parts.y, parts.mo, parts.d, Math.floor(mins / 60), mins % 60, tz),
            type: 'salah',
            prayer: p,
          });
        }
      } catch (e) {
        salahOk = false;
        console.error(`salah fetch failed for ${parts.key}:`, e.message);
      }
    }
  }

  /* Leads + at-time for every event — mirrors index.html exactly, including
     the id suffixes, so the app's own local timers and these pushes collapse
     onto the same notification tag instead of firing twice. */
  for (const evt of events) {
    for (const [lead, label] of LEADS) {
      schedule.push({
        id: `${evt.id}-${lead}`,
        title: evt.title,
        body: `In ${label}${evt.sub ? ' · ' + evt.sub : ''}`,
        fireAt: evt.at - lead * 60_000,
        type: evt.type,
        ...(evt.prayer ? { prayer: evt.prayer } : {}),
      });
    }
    schedule.push({
      id: `${evt.id}-0`,
      title: evt.title,
      body: evt.type === 'salah' ? 'Prayer time' : `Starting now${evt.sub ? ' · ' + evt.sub : ''}`,
      fireAt: evt.at,
      type: evt.type === 'salah' ? 'salah_athan' : 'meeting',
      ...(evt.prayer ? { prayer: evt.prayer } : {}),
    });
  }

  return { schedule, ok: salahOk };
}

/* Earliest not-yet-delivered entry, or 0 once everything planned is done.
   Observability only — delivery never filters on it (see the design notes). */
export function nextFireAt(schedule, sentSet) {
  const pending = schedule.filter(n => !sentSet.has(n.id)).map(n => n.fireAt);
  return pending.length ? Math.min(...pending) : 0;
}

// ─── One tick ─────────────────────────────────────────────────────────────────

async function tick(env) {
  const now = Date.now();

  const stateRow = await env.DB.prepare('SELECT data FROM state WHERE id = 1').first();
  const state    = stateRow?.data ? parseJson(stateRow.data, null) : null;

  const tz    = state?.ui?.timezone || DEFAULT_TZ;
  /* Today and tomorrow: a 15-minute lead on a 00:05 meeting fires at 23:50
     today, so tomorrow has to be in the plan before midnight to be sent. */
  const days  = [zonedParts(tz, 0), zonedParts(tz, 1)];

  /* plan === null means "no trustworthy plan this tick" — a missing/corrupt
     state row, or a failed prayer-time fetch. Fall back to whatever is stored
     rather than delivering from a plan known to be incomplete. */
  let plan = null;
  if (state) {
    const { schedule, ok } = await buildSchedule(state, tz, days);
    if (ok) plan = schedule;
    else console.error('tick: salah fetch failed, using stored plans this tick');
  } else {
    console.error('tick: state row missing or unparseable, using stored plans');
  }

  /* Every row, every tick — no next_fire_at filter. A row that filters itself
     out of selection can never recover, which is exactly how the previous
     version went permanently silent. */
  const rows = await env.DB.prepare(
    'SELECT id, subscription, schedule, sent FROM push_subs'
  ).all();

  const writes = [];
  let sentCount = 0;

  await Promise.all((rows.results || []).map(async row => {
    try {
      const sub = parseJson(row.subscription, null);
      if (!sub?.endpoint) return;

      const stored = parseJson(row.schedule, []) || [];
      /* One-off entries (pomodoro, "send test notification") are pushed by the
         client into `schedule` and are not derivable from state, so they must
         survive the rebuild rather than being replaced by it. */
      const oneoffs = stored.filter(n => n?.oneoff);
      const schedule = plan ? [...plan, ...oneoffs] : stored;

      const planIds = new Set(schedule.map(n => n.id));
      /* Self-pruning: ids embed their date, so an id that has dropped out of
         the plan is in the past and can be forgotten. This replaces a daily
         reset and with it the midnight double-send edge cases. */
      const sentSet = new Set((parseJson(row.sent, []) || []).filter(id => planIds.has(id)));

      const due = schedule.filter(n =>
        Number.isFinite(n?.fireAt) && !sentSet.has(n.id) && n.fireAt <= now + LOOK_AHEAD_MS);

      let subscriptionGone = false;
      let anySent = false;

      /* allSettled so one throw doesn't take the whole batch down — each
         notification's outcome is judged independently below. */
      const results = await Promise.allSettled(due.map(async n => {
        if (n.fireAt < now - staleAfter(n.id)) return 'stale';
        return sendPush(sub, {
          title:  n.title,
          body:   n.body || '',
          id:     n.id,
          type:   n.type   ?? 'meeting',
          prayer: n.prayer ?? null,
        }, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT, staleAfter(n.id));
      }));

      due.forEach((n, i) => {
        const r = results[i];
        if (r.status !== 'fulfilled') {
          /* Network error — leave unsent so the next tick retries it. */
          console.error(`push → ${row.id} [${n.title}] threw:`, r.reason?.message);
          return;
        }
        if (r.value === 'stale') {
          console.log(`push → ${row.id} [${n.title}]: ${Math.round((now - n.fireAt) / 60000)}m late, retiring`);
          sentSet.add(n.id);
          return;
        }
        const s = r.value;
        console.log(`push → ${row.id} [${n.title}] → HTTP ${s}`);
        /* 404/410 means the push service will never accept this subscription
           again — delete it rather than keep retrying forever. */
        if (s === 404 || s === 410) { subscriptionGone = true; return; }
        if (s >= 200 && s < 300) { sentSet.add(n.id); anySent = true; sentCount++; return; }
        /* Any other non-2xx: leave unsent, retried each tick until stale. */
      });

      if (subscriptionGone) {
        console.log(`push: subscription gone, removing ${row.id}`);
        writes.push(env.DB.prepare('DELETE FROM push_subs WHERE id = ?').bind(row.id));
        return;
      }

      /* Drop delivered one-offs so they don't linger in the stored schedule. */
      const keptOneoffs = oneoffs.filter(n => !sentSet.has(n.id));
      const scheduleJson = JSON.stringify(keptOneoffs);
      const sentJson     = JSON.stringify([...sentSet]);

      if (!anySent && scheduleJson === (row.schedule || '[]') && sentJson === (row.sent || '[]')) return;

      /* updated_at is the liveness signal cleanupStaleSubscriptions uses, so it
         must mean "still genuinely working", not merely "was queried". */
      writes.push(anySent
        ? env.DB.prepare(
            'UPDATE push_subs SET schedule = ?, sent = ?, next_fire_at = ?, updated_at = ? WHERE id = ?'
          ).bind(scheduleJson, sentJson, nextFireAt(schedule, sentSet), now, row.id)
        : env.DB.prepare(
            'UPDATE push_subs SET schedule = ?, sent = ?, next_fire_at = ? WHERE id = ?'
          ).bind(scheduleJson, sentJson, nextFireAt(schedule, sentSet), row.id));

    } catch (e) {
      console.error(`push error for ${row.id}:`, e.message);
    }
  }));

  if (writes.length) await env.DB.batch(writes);
  return {
    devices: (rows.results || []).length,
    planned: plan?.length ?? null,
    sent: sentCount,
    writes: writes.length,
    tz,
    day: days[0].key,
  };
}

/* Safety net: a subscription that hasn't successfully received anything, nor
   been re-confirmed by its own client, in this long is almost certainly dead
   (uninstalled PWA, cleared site data, revoked permission). updated_at is
   bumped both by the client's subscribe/re-sync POST and by a successful send,
   so this only catches rows that are genuinely not working — never a device
   quietly receiving background pushes without reopening the app. */
const STALE_SUBSCRIPTION_MS = 30 * 24 * 60 * 60 * 1000;

async function cleanupStaleSubscriptions(env) {
  try {
    const cutoff = Date.now() - STALE_SUBSCRIPTION_MS;
    const result = await env.DB.prepare('DELETE FROM push_subs WHERE updated_at < ?').bind(cutoff).run();
    if (result.meta?.changes) console.log(`cleanup: removed ${result.meta.changes} stale push subscription(s)`);
  } catch (e) {
    console.error('cleanupStaleSubscriptions failed:', e.message);
  }
}

/* Immediate one-off to every registered device — proves the whole pipeline
   (VAPID keys, encryption, subscription validity, service worker) end to end
   without waiting for a real reminder to come due. */
async function sendTest(env) {
  const rows = await env.DB.prepare('SELECT id, subscription FROM push_subs').all();
  const out = [];
  for (const row of rows.results || []) {
    const sub = parseJson(row.subscription, null);
    if (!sub?.endpoint) continue;
    try {
      const status = await sendPush(sub, {
        title: 'Folio', body: 'Test notification — push is working.',
        id: `test-${Date.now()}`, type: 'test', prayer: null,
      }, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT, 60_000);
      if (status === 404 || status === 410) {
        await env.DB.prepare('DELETE FROM push_subs WHERE id = ?').bind(row.id).run();
      }
      out.push({ id: row.id.slice(-24), status });
    } catch (e) {
      out.push({ id: row.id.slice(-24), error: e.message });
    }
  }
  return { devices: (rows.results || []).length, results: out };
}

// ─── Entry points ─────────────────────────────────────────────────────────────

export default {
  /* Deliberately ignores event.cron — any trigger firing at least once a
     minute drives the whole system. Keying behaviour off an exact cron string
     silently disables things whenever the deployed schedule doesn't match. */
  async scheduled(_event, env, ctx) {
    await tick(env);
    /* Housekeeping only — must never delay or fail a delivery tick. */
    if (new Date().getUTCMinutes() === 0) ctx.waitUntil(cleanupStaleSubscriptions(env));
  },

  async fetch(req, env) {
    const url = new URL(req.url);
    const authed = async () => tokenOk(
      (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim(),
      env.SYNC_TOKEN,
    );

    /* Force a tick — verify the pipeline without waiting for the next cron. */
    if (req.method === 'POST' && url.pathname === '/run') {
      if (!await authed()) return new Response('Unauthorized', { status: 401 });
      return Response.json(await tick(env));
    }

    /* Send an immediate test notification to every registered device. */
    if (req.method === 'POST' && url.pathname === '/test') {
      if (!await authed()) return new Response('Unauthorized', { status: 401 });
      return Response.json(await sendTest(env));
    }

    /* Read-only health view: what the worker currently believes is scheduled. */
    if (req.method === 'GET' && url.pathname === '/status') {
      if (!await authed()) return new Response('Unauthorized', { status: 401 });
      const stateRow = await env.DB.prepare('SELECT data FROM state WHERE id = 1').first();
      const state = stateRow?.data ? parseJson(stateRow.data, null) : null;
      const tz = state?.ui?.timezone || DEFAULT_TZ;
      const days = [zonedParts(tz, 0), zonedParts(tz, 1)];
      const { schedule, ok } = await buildSchedule(state, tz, days);
      const rows = await env.DB.prepare('SELECT id, sent, updated_at FROM push_subs').all();
      const now = Date.now();
      return Response.json({
        tz,
        now: new Date(now).toISOString(),
        salahOk: ok,
        planned: schedule.length,
        upcoming: schedule
          .filter(n => n.fireAt > now)
          .sort((a, b) => a.fireAt - b.fireAt)
          .slice(0, 10)
          .map(n => ({ id: n.id, title: n.title, at: new Date(n.fireAt).toISOString() })),
        devices: (rows.results || []).map(r => ({
          id: r.id.slice(-24),
          sentToday: (parseJson(r.sent, []) || []).length,
          lastConfirmed: r.updated_at ? new Date(r.updated_at).toISOString() : null,
        })),
      });
    }

    return new Response('Folio Push Worker', { status: 200 });
  },
};
