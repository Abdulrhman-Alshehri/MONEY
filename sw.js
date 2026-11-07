const C = 'spend-v2';
// A new version takes over straight away, so the push handler below is the one that runs
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(C).then(c => c.addAll(['./index.html', './manifest.json', './icon.svg']))); });
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
// Every push is shown: iOS stops delivering to a web app that receives pushes without showing them
self.addEventListener('push', e => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch (err) { m = {body: e.data ? e.data.text() : ''}; }
  e.waitUntil(self.registration.showNotification(m.title || 'Spending', {body: m.body || '', tag: m.tag || undefined, icon: 'icon.svg', data: {url: './'}}));
});
// Tapping a notification opens the app, or brings it forward if it's already open
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(list => {
    const w = list.find(c => new URL(c.url).origin === location.origin);
    return w ? w.focus() : self.clients.openWindow(e.notification.data && e.notification.data.url || './');
  }));
});
