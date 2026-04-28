var CACHE='quantex-v2';
var SHELL=['./quantex-pro.html','./manifest.json'];

self.addEventListener('install',function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){return c.addAll(SHELL);}).then(function(){return self.skipWaiting();}));
});
self.addEventListener('activate',function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){return k!==CACHE;}).map(function(k){return caches.delete(k);}));
  }).then(function(){return self.clients.claim();}));
});
self.addEventListener('fetch',function(e){
  var url=e.request.url;
  // API calls - network only
  if(url.includes('allorigins')||url.includes('yahoo')||url.includes('finance')){
    e.respondWith(fetch(e.request).catch(function(){return new Response('{}',{headers:{'Content-Type':'application/json'}});}));
    return;
  }
  // App shell - cache first
  e.respondWith(
    caches.match(e.request).then(function(cached){
      if(cached)return cached;
      return fetch(e.request).then(function(res){
        if(res&&res.status===200){
          var clone=res.clone();
          caches.open(CACHE).then(function(c){c.put(e.request,clone);});
        }
        return res;
      }).catch(function(){return caches.match('./quantex-pro.html');});
    })
  );
});
