// Healthy Fit — service worker: пуш-уведомления + запасная копия оболочки приложения для работы без сети.
// Всегда сначала сеть (обновления приходят сразу), кэш — только если сети нет: дневник хранится на телефоне и должен открываться офлайн.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

const SHELL = 'hf-shell-v1';
const STATIC = /\.(js|css|woff2|png|jpg|svg|webmanifest)$/;
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin !== self.location.origin || u.pathname.startsWith('/api/') || u.pathname.startsWith('/media/') || u.pathname === '/sw.js') return;
  const nav = r.mode === 'navigate';
  if (!nav && !STATIC.test(u.pathname)) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(r);
      if (res.ok && (!nav || u.pathname === '/')) { const c = await caches.open(SHELL); c.put(nav ? '/' : u.pathname, res.clone()).catch(() => {}); }
      return res;
    } catch (err) {
      const c = await caches.open(SHELL), hit = await c.match(nav ? '/' : u.pathname);
      if (hit) return hit;
      throw err;
    }
  })());
});

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // открытой вкладке — для всплывашки внутри приложения
    for (const w of wins) w.postMessage({ type: 'push', data: d });
    // приложение открыто на экране — хватит всплывашки внутри. Исключение — Apple: iOS отзывает подписку за «молчаливые» пуши
    const apple = /iPhone|iPad|Macintosh/.test(self.navigator.userAgent);
    if (!apple && wins.some(w => w.visibilityState === 'visible' && w.focused)) return;
    await self.registration.showNotification(d.title || 'Healthy Fit', {
      body: d.body || '', icon: '/icon-192.png', badge: '/icon-192.png', tag: d.tag || undefined, renotify: Boolean(d.tag),
      data: { url: d.url || '/' },
    });
    if (self.navigator && 'setAppBadge' in self.navigator) try { await self.navigator.setAppBadge(); } catch {}
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const w = wins.find(x => new URL(x.url).origin === self.location.origin);
    if (w) { await w.focus(); w.postMessage({ type: 'open', url }); return; }
    await self.clients.openWindow(url);
  })());
});

// push-сервис сменил подписку (бывает на iOS и Android) — сразу оформляем новую и сообщаем серверу, иначе пуши молча пропадут
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil((async () => {
    try {
      const { key } = await (await fetch('/api/push/key', { credentials: 'same-origin' })).json();
      const raw = atob(key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - key.length % 4) % 4));
      const sub = e.newSubscription || await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, c => c.charCodeAt(0)) });
      await fetch('/api/push/subscribe', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub.toJSON()) });
    } catch {}
  })());
});
