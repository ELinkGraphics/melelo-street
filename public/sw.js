/* Melelo storefront service worker.
 *
 * Goal: near-instant repeat opens on any network.
 *  - Images (/models/, *.webp/png/jpg) and hashed bundles (/assets/) are
 *    CACHE-FIRST: after the first visit they load from disk, even offline.
 *  - Supabase product images (public bucket) are cache-first too — filenames
 *    are unique per upload, so they never go stale.
 *  - Navigations are STALE-WHILE-REVALIDATE: the cached shell renders
 *    immediately while a fresh copy downloads in the background (picked up on
 *    the next open).
 *
 * Bump VERSION on breaking changes to drop all old caches.
 */
const VERSION = 'v1';
const CACHE = `melelo-${VERSION}`;

const PRECACHE = [
  '/',
  '/bg.webp',
  '/logo.webp',
  '/models/hero_model.webp',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const isImage = (url) =>
  /\.(webp|png|jpe?g|gif|svg|avif)$/i.test(url.pathname) ||
  url.pathname.startsWith('/models/');

const isHashedAsset = (url) => url.pathname.startsWith('/assets/');

const isSupabaseImage = (url) =>
  url.hostname.endsWith('.supabase.co') &&
  url.pathname.includes('/storage/v1/object/public/product-images/');

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // App shell: serve cached instantly, refresh in the background.
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match('/');
        const refresh = fetch(req)
          .then((res) => { if (res.ok) cache.put('/', res.clone()); return res; })
          .catch(() => cached);
        return cached || refresh;
      })
    );
    return;
  }

  // Static images + hashed bundles: cache-first.
  if (isHashedAsset(url) || (url.origin === self.location.origin && isImage(url)) || isSupabaseImage(url)) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      })
    );
  }
});
