const CACHE='easyway-learn-v3';
const ASSETS=['./','./index.html','./styles.css','./app.js','./manifest.webmanifest'];

self.addEventListener('install',e=>{
  e.waitUntil(
    caches.open(CACHE)
      .then(c=>c.addAll(ASSETS))
      .then(()=>self.skipWaiting())
  );
});

self.addEventListener('activate',e=>{
  e.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(
        keys
          .filter(k=>k.startsWith('easyway-learn-') && k!==CACHE)
          .map(k=>caches.delete(k))
      ))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch',e=>{
  e.respondWith(
    caches.match(e.request)
      .then(c=>c || fetch(e.request).then(r=>{
        const copy=r.clone();
        caches.open(CACHE).then(x=>x.put(e.request,copy));
        return r;
      }).catch(()=>caches.match('./index.html')))
  );
});
