// MyLife service worker: push notifications + offline shell.
const CACHE = 'mylife-v2';
const SHELL = ['/', '/index.html', '/app.js', '/styles.css', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// network first, fall back to cache (API calls are never cached)
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/index.html'))),
  );
});

self.addEventListener('push', (e) => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch { p = { title: 'MyLife', body: e.data?.text() }; }
  e.waitUntil(
    self.registration.showNotification(p.title || 'MyLife', {
      body: p.body || '',
      tag: p.tag,
      renotify: !!p.tag,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      data: p.data || {},
      actions: p.actions || [],
      vibrate: [120, 60, 120],
    }),
  );
});

const post = (path, body) =>
  fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

self.addEventListener('notificationclick', (e) => {
  const n = e.notification;
  const d = n.data || {};
  n.close();
  e.waitUntil((async () => {
    if (e.action === 'done' && d.itemId) return post(`/api/items/${d.itemId}/done`);
    if (e.action === 'snooze' && d.itemId) return post(`/api/items/${d.itemId}/snooze`, { minutes: 15 });
    if (e.action === 'resisted' && d.cravingId) {
      return fetch(`/api/cravings/${d.cravingId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome: 'resisted' }),
      });
    }
    const url = d.url || '/#heute';
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if ('focus' in w) {
        await w.focus();
        w.postMessage({ type: 'nav', url });
        return;
      }
    }
    return self.clients.openWindow(url);
  })());
});
