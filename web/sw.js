/* Offline support: ward data is immutable per release, so cache it forever.
 * The app shell is network-first so updates land without a hard refresh. */
const CACHE = 'ukowapi-v2';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'geo.js',
               'manifest.webmanifest', 'icon.svg', 'data/index.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return; // let Leaflet/tiles hit the network

  // Region data never changes within a release: serve from cache, fetch once.
  if (url.pathname.includes('/data/')) {
    e.respondWith(
      caches.match(request).then((hit) => hit || fetch(request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy));
        return res;
      }))
    );
    return;
  }

  e.respondWith(
    fetch(request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(request, copy));
      return res;
    }).catch(() => caches.match(request))
  );
});
