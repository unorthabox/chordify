// Chordify offline shell.
// Bump VERSION only to force-evict; routine edits to index.html propagate on
// their own via the stale-while-revalidate below.
const VERSION = 'v2';
const CACHE = 'chordify-' + VERSION;
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-180.png'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // allSettled, not addAll: one bad entry shouldn't sink the whole install.
    await Promise.allSettled(SHELL.map(u => cache.add(new Request(u, {cache: 'reload'}))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // YouTube, Piped, ytimg: always live, never cached. Offline they just fail,
  // which the app already handles — the rest of it keeps working.
  if (url.origin !== self.location.origin) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, {ignoreSearch: true});

    const fresh = fetch(req).then(res => {
      if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    }).catch(() => null);

    if (hit) {
      e.waitUntil(fresh);
      return hit;
    }

    const res = await fresh;
    if (res) return res;

    if (req.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    return Response.error();
  })());
});
