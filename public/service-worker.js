/* Campfire service worker.
 * - Page loads (navigations) are network-first: you always get the newest
 *   shell when online, cache only when offline. (The chat needs network
 *   anyway, so there's no benefit to serving a stale shell.)
 * - Other assets are cache-first with background refresh.
 * - On activate, old caches are dropped and the new worker takes over
 *   immediately. Live tabs are pinged so the in-app auto-updater (which is
 *   voice-aware and draft-safe) checks the version right away — the worker
 *   never force-reloads pages itself, so a fresh SW install can't yank a
 *   tab out from under its first load.
 */
const CACHE = 'campfire-v304';
const SHELL = ['/', '/index.html', '/styles.css', '/embeds.js', '/js/core.js', '/js/auth.js', '/js/noise.js', '/js/servers.js', '/js/messages.js', '/js/socket.js', '/js/ui.js', '/js/voice.js', '/js/actions.js', '/js/rail.js', '/js/home.js', '/js/pins.js', '/js/share.js', '/js/compose.js', '/js/pickers.js', '/js/settings.js', '/js/admin.js', '/js/security.js', '/js/final.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/icons/apple-touch-icon.png', '/icons/campfire-logo.png', '/favicon.ico', '/favicon-32.png', '/emoji.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(async () => {
        const wins = await self.clients.matchAll({ type: 'window' });
        wins.forEach((w) => { try { w.postMessage({ t: 'SW_PING', v: CACHE }); } catch {} });
      })
  );
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil(self.registration.showNotification(d.title || 'Campfire', {
    body: d.body || '',
    icon: d.icon || '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: d.tag || 'campfire',
    renotify: true,
    data: { url: d.url || '/' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    for (const w of wins) {
      if ('focus' in w) {
        try { w.focus(); } catch {}
        if ('navigate' in w) { try { w.navigate(url); } catch {} }
        return;
      }
    }
    if (clients.openWindow) return clients.openWindow(url);
  }));
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
