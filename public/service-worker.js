/* Campfire service worker.
 * - Page loads (navigations) are network-first: you always get the newest
 *   shell when online, cache only when offline. (The chat needs network
 *   anyway, so there's no benefit to serving a stale shell.)
 * - Other assets are cache-first with background refresh.
 * - On activate, tabs running code predating the auto-updater are reloaded
 *   once so nobody gets stuck on an ancient version. Tabs with the updater
 *   reply to the ping and handle it themselves (voice-aware, draft-safe).
 */
const CACHE = 'campfire-v29';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/emoji.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

const pongIds = new Set();
self.addEventListener('message', (e) => {
  if (e.data && e.data.t === 'SW_PONG' && e.source) pongIds.add(e.source.id);
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(async () => {
        const wins = await self.clients.matchAll({ type: 'window' });
        wins.forEach((w) => { try { w.postMessage({ t: 'SW_PING', v: CACHE }); } catch {} });
        await new Promise((res) => setTimeout(res, 4000));
        const fresh = await self.clients.matchAll({ type: 'window' });
        for (const w of fresh) {
          if (!pongIds.has(w.id)) { try { await w.navigate(w.url); } catch {} }
        }
      })
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return; // never cache API/WS
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then((res) => {
        if (res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => caches.match(e.request).then((hit) => hit || caches.match('/index.html')))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const net = fetch(e.request).then((res) => {
        if (res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
