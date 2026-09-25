const CACHE = 'easyway-learn-v58';
self.addEventListener('install', event => {
  self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Network-first for app code/pages so a new Render deployment is never hidden by stale JS.
  if (['/','/index.html','/app.js','/styles.css','/sw.js','/manifest.webmanifest'].includes(url.pathname)) {
    event.respondWith(fetch(req, {cache:'no-store'}).catch(() => caches.match(req).then(r => r || fetch(req))));
    return;
  }
  event.respondWith(caches.match(req).then(cached => cached || fetch(req).then(res => {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
    return res;
  })));
});
