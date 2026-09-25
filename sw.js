const CACHE='easyway-learn-v68';
self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  const req=e.request;if(req.method!=='GET')return;
  const url=new URL(req.url);if(url.origin!==self.location.origin)return;
  if(['/','/index.html','/app.js','/styles.css','/sw.js','/manifest.webmanifest'].includes(url.pathname)){
    e.respondWith(fetch(req,{cache:'no-store'}).then(r=>{const copy=r.clone();caches.open(CACHE).then(c=>c.put(req,copy)).catch(()=>{});return r}).catch(()=>caches.match(req).then(r=>r||Response.error())));return;
  }
  e.respondWith(fetch(req,{cache:'no-store'}).catch(()=>caches.match(req).then(r=>r||Response.error())));
});
