// オフライン対応（要件 O-1）。初回に全ファイルを端末に保存し、以降は保存したものから表示する。
// ファイルを更新したら CACHE の番号を上げること（古い保存は自動で消える）。
const CACHE = 'flightpoker-v1';
const FILES = [
  './',
  'index.html',
  'style.css',
  'manifest.webmanifest',
  'js/app.js',
  'js/cards.js',
  'js/cpu.js',
  'js/evaluator.js',
  'js/game.js',
  'js/help.js',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('flightpoker-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// ページから「保存し直して」と頼まれたとき（保存が消えていた場合の保険）
self.addEventListener('message', (event) => {
  if (event.data === 'recache') {
    event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => {
      event.source?.postMessage('recached');
    }));
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      // 保存になければネットから取り、次回のために保存しておく
      return fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => (req.mode === 'navigate' ? caches.match('index.html') : Response.error()));
    }),
  );
});
