const CACHE = 'folio-v3';

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
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

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

self.addEventListener('message', (event) => {
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

  if (type === 'salah_athan') {
    event.waitUntil(
      Promise.all([
        notify,
        self.clients.matchAll({ type: 'window', includeUncontrolled: true })
          .then(clients => clients.forEach(c => c.postMessage({ type: 'PLAY_ADHAN', prayer, title }))),
      ])
    );
  } else {
    event.waitUntil(notify);
  }
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
