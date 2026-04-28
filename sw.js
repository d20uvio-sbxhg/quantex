// v4 - 清除所有舊快取，不再快取任何內容
var CACHE='quantex-v4';

self.addEventListener('install',function(e){
  self.skipWaiting();
});

self.addEventListener('activate',function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.map(function(k){
        console.log('Deleting cache:',k);
        return caches.delete(k);
      }));
    }).then(function(){
      return self.clients.claim();
    })
  );
});

// 所有請求都直接走網路，不快取
self.addEventListener('fetch',function(e){
  e.respondWith(fetch(e.request));
});
