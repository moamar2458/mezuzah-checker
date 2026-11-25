// Offline support: after the first visit, every file of the app is kept on the phone.
const VERSION = 'v7';
const FILES = [
  './', 'index.html', 'train.html', 'pc.html', 'style.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png',
  'fonts/StamAshkenazCLM.ttf', 'fonts/StamSefaradCLM.ttf',
  'js/app.js', 'js/align.js', 'js/camera.js', 'js/crop.js', 'js/db.js', 'js/imageproc.js', 'js/library.js',
  'js/nn.js', 'js/pipeline.js', 'js/problems.js', 'js/reference.js', 'js/segment.js', 'js/synth.js',
  'js/train-app.js', 'js/train-worker.js', 'js/worker.js', 'js/train-core.js', 'js/report.js', 'js/sync.js', 'js/pc-app.js', 'js/customers.js', 'js/compare.js', 'js/fraud.js', 'js/certificate.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Use the network when there is one (so updates arrive), otherwise the saved copy.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  if (new URL(e.request.url).pathname.startsWith('/api/')) return; // talking to the PC: never from the cache
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok && new URL(e.request.url).origin === location.origin) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
