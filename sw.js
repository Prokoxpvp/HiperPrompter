/* Service worker — pełne działanie offline po pierwszym załadowaniu */
var CACHE = 'teleprompter-v2';
var ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './qr.js',
  './manifest.json',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  // Nawigacje: cache-first z fallbackiem na index.html (offline)
  if (req.mode === 'navigate') {
    e.respondWith(
      caches.match('./index.html').then(function (cached) {
        return cached || fetch(req);
      })
    );
    return;
  }

  // Reszta: stale-while-revalidate (szybko z cache, aktualizacja w tle)
  e.respondWith(
    caches.match(req).then(function (cached) {
      var network = fetch(req).then(function (res) {
        if (res && res.status === 200 && (res.type === 'basic' || res.type === 'cors')) {
          var clone = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, clone); });
        }
        return res;
      }).catch(function () { return cached; });
      return cached || network;
    })
  );
});
