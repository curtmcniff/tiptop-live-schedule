// Bump VERSION on any shell change (index.html, app.js, style.css, manifest, icons), and change
// index.html's "app.js?vN" and "style.css?vN" to the same VERSION in the same change.
// Why the ?vN: the page itself comes from the network when online, but app.js / style.css are
// served from the phone's saved copy. Without a version in their URL a new page could run with the
// previous version's script (2026-11-23: the new filter dropdowns came up empty on an iPhone).
// With it, a new page asks for app.js?v5, finds nothing saved under that name and fetches it.
const VERSION = 'v19';
const SHELL_CACHE = 'shell-' + VERSION;
const DATA_CACHE = 'data-live'; // separate from shell so shell bumps never wipe the saved schedule
const SHELL = [
  './', 'index.html', 'app.js?' + VERSION, 'tarping_log.js?' + VERSION, 'tarp_engine.js?' + VERSION, 'style.css?' + VERSION, 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/logo-white.png', 'icons/favicon-32.png'
];

const DATA_TIMEOUT_MS = 4000; // weak signal: show the saved copy instead of hanging

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      // cache:'reload' skips the HTTP cache (GitHub Pages sends max-age=600) so a version bump gets fresh files
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      // save the schedule on the very first visit too (that page load fetched data.json before
      // this worker existed); best effort, never fails the install
      .then(() => fetch('data.json', { cache: 'no-store' })
        .then((r) => (r.ok ? caches.open(DATA_CACHE).then((c) => c.put('data.json', r)) : null))
        .catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first with a time limit. If the network loses the race (or fails, or returns an error
// status) the last good copy is served, marked X-From-Cache, and the network fetch keeps running
// in the background to refresh the cache for next time.
async function dataRequest(e) {
  const cache = await caches.open(DATA_CACHE);
  const network = fetch(e.request.url, { cache: 'no-store' }).then(async (res) => {
    if (res && res.ok) await cache.put('data.json', res.clone());
    return res;
  });
  network.catch(() => {});
  e.waitUntil(network.catch(() => {}));
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), DATA_TIMEOUT_MS));
  try {
    const res = await Promise.race([network, timeout]);
    if (res && res.ok) return res;
  } catch (err) { /* fall through to the saved copy */ }
  const hit = await cache.match('data.json');
  if (hit) {
    const headers = new Headers(hit.headers);
    headers.set('X-From-Cache', '1');
    return new Response(await hit.blob(), { status: hit.status, statusText: hit.statusText, headers });
  }
  try {
    return await network; // nothing saved yet: wait for the network after all
  } catch (err) {
    return new Response(JSON.stringify({ error: 'offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.endsWith('/data.json')) {
    e.respondWith(dataRequest(e));
    return;
  }
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(() => caches.match('index.html').then((r) => r || caches.match('./')))
    );
    return;
  }
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req))
  );
});
