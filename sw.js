// Offline support and fast launches. Every file is served from the cache, so the app opens
// without waiting for the network. A new version (a new CACHE name) downloads in the background
// and waits; it takes over on the next launch, so files from two versions never mix (an old
// journal.js with a new app.js breaks the app).
// Only runs over HTTPS (service workers need a secure origin).

// Prefixed so the English app's caches on the same origin are left alone.
const CACHE = 'bible-scroll-ml-v69';
const ASSETS = [
  './', 'index.html', 'style.css', 'app.js', 'journal.js', 'books.js', 'mal1910.json',
  'manifest.webmanifest', 'icons/scroll-180.png', 'icons/scroll-192.png', 'icons/scroll-512.png',
];

self.addEventListener('install', (event) => {
  // 'reload' skips the browser's HTTP cache, which can still hold files from the last version.
  const fresh = ASSETS.map((url) => new Request(url, { cache: 'reload' }));
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(fresh)));
});

const version = (name) => Number(/^bible-scroll-ml-v(\d+)$/.exec(name)?.[1] ?? NaN);

/**
 * Deletes the caches of earlier versions, and only those: a newer version may be downloading
 * into its own cache while this one still runs.
 */
async function deleteOldCaches() {
  const keys = await caches.keys();
  await Promise.all(keys.filter((k) => version(k) < version(CACHE)).map((k) => caches.delete(k)));
}

self.addEventListener('activate', (event) => {
  event.waitUntil(deleteOldCaches().then(() => self.clients.claim()));
});

// iOS can activate a new version without finishing the clean-up above, which left every old
// version's files on the phone. So the worker also tidies up on the first request it serves.
let tidied = false;

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(cacheFirst(request));
  if (!tidied) {
    tidied = true;
    event.waitUntil(deleteOldCaches());
  }
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}
