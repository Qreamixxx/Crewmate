// Crewmate service worker: makes the site installable and opens the app shell when the connection drops.
// It never caches /api, so data is always live and private.
const CACHE = 'crewmate-shell-v6';
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/', '/icon-192.png'])).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/') || u.pathname === '/healthz') return;
  if (r.mode === 'navigate') {
    e.respondWith(fetch(r).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put('/', copy)); return res; }).catch(() => caches.match('/')));
    return;
  }
  e.respondWith(caches.match(r).then(hit => { const net = fetch(r).then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(r, copy)); } return res; }).catch(() => hit); return hit || net; }));
});
// Notifications: the push has no payload; ask the server what to show (falls back to a generic line when signed out).
self.addEventListener('push', e => {
  e.waitUntil(fetch('/api/push/latest', { credentials: 'same-origin', cache: 'no-store' }).then(r => (r.ok ? r.json() : {})).catch(() => ({}))
    .then(j => self.registration.showNotification(j.group ? 'Crewmate · ' + j.group : 'Crewmate', { body: j.text || 'Something new from your crew.', icon: '/icon-192.png', badge: '/icon-192.png', tag: 'crewmate', renotify: true })));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => (cs[0] ? cs[0].focus() : self.clients.openWindow('/#/inbox'))));
});
