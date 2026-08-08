const CACHE = 'folio-v22';

/* Caches used as cross-context storage rather than HTTP caching — a SW has no
   localStorage, so the sync token (needed to re-register a subscription with
   no window ever open) and the notification-delivery log both live here as
   synthetic Response bodies under a fixed key. Named separately from CACHE so
   the version-bump cleanup below doesn't sweep them. */
const AUTH_CACHE     = 'folio-auth';
const NOTIF_LOG_CACHE = 'folio-notif-log';
const AUTH_KEY      = '/__auth_token';
const NOTIF_LOG_KEY = '/__notif_log';
const NOTIF_LOG_MAX = 50;

const VAPID_PUBLIC_KEY = 'BMg79Dc4KgbVAa253omi5oER5VpB3ErcDnjaR5lgmIinGMVlUpe4-LUgfuQrTb9a3urAaLnDZgQ_vtE4OvVLcPA';
/* Duplicated from index.html on purpose — same reasoning as the buildSchedule
   mirror between the client and push-worker: a SW is its own script scope
   with no access to the page's globals. Keep both copies in sync by hand. */
function vapidKeyBytes() {
  const pad = VAPID_PUBLIC_KEY.length % 4;
  const b64 = (pad ? VAPID_PUBLIC_KEY + '='.repeat(4 - pad) : VAPID_PUBLIC_KEY)
    .replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function readAuthToken() {
  try {
    const cache = await caches.open(AUTH_CACHE);
    const res = await cache.match(AUTH_KEY);
    return res ? await res.text() : null;
  } catch { return null; }
}

async function logNotification(entry) {
  try {
    const cache = await caches.open(NOTIF_LOG_CACHE);
    const res = await cache.match(NOTIF_LOG_KEY);
    let log = [];
    if (res) { try { log = await res.json(); } catch {} }
    log.unshift(entry);
    if (log.length > NOTIF_LOG_MAX) log.length = NOTIF_LOG_MAX;
    await cache.put(NOTIF_LOG_KEY, new Response(JSON.stringify(log), {
      headers: { 'Content-Type': 'application/json' },
    }));
  } catch {}
}

const SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/folio-icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/vendor/react.min.js',
  '/vendor/react-dom.min.js',
  '/vendor/babel.min.js',
  '/vendor/tailwind.min.js',
  '/vendor/prism-tomorrow.min.css',
  '/vendor/prism.min.js',
  '/vendor/prism-javascript.min.js',
  '/vendor/prism-typescript.min.js',
  '/vendor/prism-python.min.js',
  '/vendor/prism-rust.min.js',
  '/vendor/prism-go.min.js',
  '/vendor/prism-bash.min.js',
  '/vendor/prism-powershell.min.js',
  '/vendor/prism-sql.min.js',
  '/vendor/prism-json.min.js',
  '/vendor/prism-css.min.js',
  '/vendor/prism-jsx.min.js',
  '/vendor/prism-csharp.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE && k !== AUTH_CACHE && k !== NOTIF_LOG_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never intercept cross-origin requests
  if (url.origin !== self.location.origin) return;

  // API calls — never intercept, let them reach the network
  if (url.pathname.startsWith('/api/')) return;

  // Google Fonts — stale-while-revalidate
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const networkFetch = fetch(request)
          .then((resp) => { cache.put(request, resp.clone()); return resp; })
          .catch(() => cached);
        return cached || networkFetch;
      })
    );
    return;
  }

  // Everything else (app shell, CDN scripts) — cache-first
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((resp) => {
          caches.open(CACHE).then((c) => c.put(request, resp.clone()));
          return resp;
        })
    )
  );
});

// Calendar meeting alerts — page posts SCHEDULE_NOTIFICATIONS with a timetable
const pendingTimers = new Map();

// Pomodoro phase-end alert — independent single timer so it never clobbers
// (or gets clobbered by) the meeting/salah schedule above
let pomodoroTimer = null;

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SCHEDULE_POMODORO') {
    if (pomodoroTimer) { clearTimeout(pomodoroTimer); pomodoroTimer = null; }
    const n = event.data.notification;
    if (!n) return;
    const delay = n.fireAt - Date.now();
    if (delay <= 0 || delay > 4 * 60 * 60 * 1000) return; // sanity cap: 4h
    pomodoroTimer = setTimeout(() => {
      self.registration.showNotification(n.title, {
        body:     n.body,
        icon:     '/icons/icon-192.png',
        badge:    '/icons/icon-192.png',
        tag:      'pomodoro',
        renotify: true,
        data:     { url: '/' },
      });
      logNotification({ id: 'pomodoro', title: n.title, body: n.body, firedAt: Date.now(), source: 'pomodoro' });
      pomodoroTimer = null;
    }, delay);
    return;
  }

  if (event.data?.type !== 'SCHEDULE_NOTIFICATIONS') return;
  pendingTimers.forEach(t => clearTimeout(t));
  pendingTimers.clear();
  const now = Date.now();
  (event.data.notifications || []).forEach(({ id, title, body, fireAt }) => {
    const delay = fireAt - now;
    if (delay <= 0 || delay > 7 * 24 * 60 * 60 * 1000) return;
    const timer = setTimeout(() => {
      self.registration.showNotification(title, {
        body,
        icon:     '/icons/icon-192.png',
        badge:    '/icons/icon-192.png',
        tag:      id,
        renotify: false,
      });
      logNotification({ id, title, body, firedAt: Date.now(), source: 'local' });
      pendingTimers.delete(id);
    }, delay);
    pendingTimers.set(id, timer);
  });
});

// Push notifications (from background push-worker via Web Push)
self.addEventListener('push', (event) => {
  const d = event.data?.json() ?? {};
  const { title = 'Folio', body = '', id, type, prayer } = d;

  const options = {
    body,
    icon:     '/icons/icon-192.png',
    badge:    '/icons/icon-192.png',
    tag:      id || type || title,
    renotify: false,
    data:     { type, prayer, url: '/' },
    vibrate:  type === 'salah_athan' ? [200, 100, 200, 100, 200] : [200],
  };

  const notify = self.registration.showNotification(title, options);
  const logged = logNotification({ id: id || type || title, title, body, firedAt: Date.now(), source: 'push' });

  if (type === 'salah_athan') {
    event.waitUntil(
      Promise.all([
        notify,
        logged,
        self.clients.matchAll({ type: 'window', includeUncontrolled: true })
          .then(clients => clients.forEach(c => c.postMessage({ type: 'PLAY_ADHAN', prayer, title }))),
      ])
    );
  } else {
    event.waitUntil(Promise.all([notify, logged]));
  }
});

/* Fires when the browser silently rotates or invalidates a subscription (key
   rotation, storage eviction) — there's no other event for this, and it can
   happen with no window ever open, so the SW has to re-subscribe itself
   using the token mirrored into AUTH_CACHE (see mirrorTokenToSW in index.html). */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const token = await readAuthToken();
    if (!token) return;
    try {
      const newSub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKeyBytes(),
      });
      await fetch('/api/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ subscription: newSub.toJSON() }),
      });
      const old = event.oldSubscription;
      if (old) {
        fetch('/api/push', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ endpoint: old.endpoint }),
        }).catch(() => {});
      }
    } catch {}
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((list) => {
      if (list.length) return list[0].focus();
      return clients.openWindow(event.notification.data || '/');
    })
  );
});
