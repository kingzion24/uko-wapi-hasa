/* Offline support.
 *
 * The previous version served everything under /data/ cache-first with no
 * revalidation, so a returning visitor kept whatever data they first loaded --
 * permanently. That meant anyone who visited before the 2018 boundary switch
 * would never see Songwe, while still receiving the new app code, because the
 * shell is network-first. New code driving old data is the worst combination.
 *
 * Now:
 *   index.json      network-first  -- small, and everything keys off it
 *   other /data/    stale-while-revalidate -- instant from cache, refreshed in
 *                   the background, so data is at most one visit behind
 *   app shell       network-first, cache as fallback
 *   vendor/         cache-first -- versioned by filename, never changes
 */
const CACHE = 'ukowapi-v3';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'geo.js',
  'manifest.webmanifest', 'icon.svg', 'data/index.json',
  'vendor/leaflet/leaflet.css', 'vendor/leaflet/leaflet.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // Don't let one missing asset abort the whole install.
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const put = (request, res) => {
  const copy = res.clone();
  caches.open(CACHE).then((c) => c.put(request, copy));
  return res;
};

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;   // map tiles, counter: network only

  // Vendored libraries are pinned by version in their path.
  if (url.pathname.includes('/vendor/')) {
    e.respondWith(caches.match(request).then((hit) => hit || fetch(request).then((r) => put(request, r))));
    return;
  }

  if (url.pathname.endsWith('/data/index.json')) {
    e.respondWith(
      fetch(request).then((r) => put(request, r)).catch(() => caches.match(request))
    );
    return;
  }

  // Ward files: serve what we have immediately, refresh for next time.
  if (url.pathname.includes('/data/')) {
    e.respondWith(
      caches.match(request).then((hit) => {
        const network = fetch(request)
          .then((r) => put(request, r))
          .catch(() => hit);
        return hit || network;
      })
    );
    return;
  }

  e.respondWith(
    fetch(request).then((r) => put(request, r)).catch(() => caches.match(request))
  );
});
