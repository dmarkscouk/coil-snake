/* Coil service worker.
 *
 * Strategy: stale-while-revalidate for same-origin GETs. The cached copy is
 * served immediately (so launches are instant and the game works with no
 * network at all), while a fresh copy is fetched in the background and stored
 * for the next launch. Pure cache-first would pin the game at whatever version
 * was installed first; network-first would make offline launches wait.
 */
const CACHE = 'coil-v4';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/game.js',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', e => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== location.origin) return;

  // an explicit bypass (devtools reload, cache:'no-store') must hit the network
  if (req.cache === 'no-store' || req.cache === 'reload') return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });

    const fresh = fetch(req).then(res => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);

    if (hit) return hit;                       // instant, revalidates behind us

    const res = await fresh;
    if (res) return res;
    if (req.mode === 'navigate') {
      const shell = await cache.match('./index.html', { ignoreSearch: true });
      if (shell) return shell;
    }
    return new Response('offline', { status: 503, statusText: 'offline' });
  })());
});
