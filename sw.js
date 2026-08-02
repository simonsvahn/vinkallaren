/* Vinkällaren: cacha endast det datafria appskalet.
   Privat masterdata, Dropbox-svar och synkoperationer får aldrig cachas här. */
const CACHE_PREFIX = 'vinkallaren-shell-';
const CACHE = `${CACHE_PREFIX}2026-07-31-1`;
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.json',
  './icon.svg',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './src/app.js?v=20260731-1',
  './src/scoring.js',
  './src/importers.js',
  './src/data-layer.js',
  './src/dropbox-live.js?v=20260731-1',
  './src/settings-store.js',
  './src/sommelier.js',
  './src/ct-live.js',
  './src/ct-merge.js',
  './src/domain/canonical.js',
  './src/domain/hlc.js',
  './src/domain/materializer.js',
  './src/domain/operations.js',
  './src/domain/repository.js',
  './src/storage/indexeddb.js',
  './src/sync/batch.js',
  './src/sync/dropbox-transport.js',
  './src/sync/errors.js',
  './src/sync/oauth-flow.js',
  './src/sync/oauth-pkce.js',
  './src/sync/session.js',
  './src/sync/sync-engine.js'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/private/') || url.pathname.includes('/ops/') || url.pathname.includes('/archive/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) caches.open(CACHE).then(cache => cache.put('./index.html', response.clone()));
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }
  event.respondWith(caches.match(request).then(hit => hit || fetch(request)));
});
