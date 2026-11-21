/* AutoCroper 서비스 워커 — 앱 파일을 캐시해 설치 후 인터넷 없이도 동작하게 한다.
 * 이미지는 여기서도 다루지 않는다(앱 파일만 캐시). 앱을 고치면 VERSION을 올린다. */
var VERSION = 'v7';
var CACHE = 'autocroper-' + VERSION;
var SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'vendor/jszip.min.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-192.png',
  'icons/maskable-512.png',
  'icons/favicon-32.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  // HTTP 캐시를 거치지 않고 새로 받아 둔다(배포 직후에도 옛 파일이 섞이지 않게)
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(SHELL.map(function (u) { return new Request(u, { cache: 'reload' }); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('autocroper-') === 0 && k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    // 화면: 온라인이면 새 버전, 오프라인이면 캐시
    e.respondWith(fetch(req).then(function (res) {
      if (res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put('./', copy); }); }
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: true }).then(function (hit) { return hit || caches.match('./'); });
    }));
    return;
  }
  // 나머지: 캐시를 먼저 쓰고, 뒤에서 새로 받아 캐시를 갱신
  e.respondWith(caches.match(req).then(function (hit) {
    var net = fetch(req).then(function (res) {
      if (res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
      return res;
    });
    if (hit) { net.catch(function () {}); return hit; }
    return net;
  }));
});
