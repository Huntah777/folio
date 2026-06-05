const CACHE = 'folio-v1';

const SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/folio-icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone@7.29.7/babel.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-javascript.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-typescript.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-python.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-rust.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-go.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-bash.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-sql.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-json.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-css.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-jsx.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-csharp.min.js',
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
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (url.pathname.startsWith('/api/')) return;

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
