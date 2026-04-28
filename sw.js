// QUANTEX Pro Service Worker
// 快取策略：Cache First for assets, Network First for API

var CACHE = 'quantex-v1';
var OFFLINE_URL = '/quantex-pro.html';

var PRECACHE = [
  '/quantex-pro.html',
  '/manifest.json'
];

// Install: precache shell
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(c) {
      return c.addAll(PRECACHE);
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

// Activate: clean old caches
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k) { return k !== CACHE; }).map(function(k) { return caches.delete(k); }));
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// Fetch strategy
self.addEventListener('fetch', function(e) {
  var url = e.request.url;

  // Yahoo Finance / allorigins API: Network only (需要即時數據)
  if (url.includes('allorigins') || url.includes('yahoo') || url.includes('finance')) {
    e.respondWith(fetch(e.request).catch(function() {
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    }));
    return;
  }

  // 外部字體 CDN: Cache First
  if (url.includes('fonts.googleapis') || url.includes('fonts.gstatic')) {
    e.respondWith(
      caches.match(e.request).then(function(cached) {
        return cached || fetch(e.request).then(function(res) {
          return caches.open(CACHE).then(function(c) { c.put(e.request, res.clone()); return res; });
        });
      })
    );
    return;
  }

  // HTML/JS/CSS: Cache First, fallback to network
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      if (cached) return cached;
      return fetch(e.request).then(function(res) {
        if (res && res.status === 200 && res.type === 'basic') {
          var clone = res.clone();
          caches.open(CACHE).then(function(c) { c.put(e.request, clone); });
        }
        return res;
      }).catch(function() {
        return caches.match(OFFLINE_URL);
      });
    })
  );
});
