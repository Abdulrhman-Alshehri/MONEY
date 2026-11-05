const C = 'spend-v2';
self.addEventListener('install', e => e.waitUntil(caches.open(C).then(c => c.addAll(['./index.html', './manifest.json', './icon.svg']))));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
