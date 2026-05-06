// QUANTEX Pro Service Worker v7.0.8
const CACHE = 'quantex-v7.0.8';
const ASSETS = ['./quantex-pro.html', './manifest.json'];

// Install - cache assets
self.addEventListener('install', function(e){
  e.waitUntil(
    caches.open(CACHE).then(function(c){return c.addAll(ASSETS);})
  );
  self.skipWaiting();
});

// Activate - clean old caches
self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){return k!==CACHE;}).map(function(k){return caches.delete(k);}));
    })
  );
  self.clients.claim();
});

// Fetch - network first for API, cache for assets
self.addEventListener('fetch', function(e){
  var url = e.request.url;
  // API requests: always network
  if(url.includes('workers.dev') || url.includes('yahoo') || url.includes('twse')){
    e.respondWith(fetch(e.request).catch(function(){return new Response('{}');}));
    return;
  }
  // HTML: always network, never cache (ensure latest version)
  if(url.includes('quantex-pro.html')){
    e.respondWith(fetch(e.request).catch(function(){return caches.match(e.request);}));
    return;
  }
  e.respondWith(caches.match(e.request).then(function(r){return r||fetch(e.request);}));
});

// Background sync - keep data fresh
self.addEventListener('periodicsync', function(e){
  if(e.tag === 'quantex-refresh'){
    e.waitUntil(
      // Notify open clients to refresh
      self.clients.matchAll().then(function(clients){
        clients.forEach(function(c){c.postMessage({type:'BG_REFRESH'});});
      })
    );
  }
});
