// Service worker of the installed app. The build prepends `CACHE` (a name that
// changes with every build) and `FILES` (every file of the build, relative to
// the scope), see src/pwa/plugin.ts.
/* global CACHE, FILES */

const scope = (path) => new URL(path, self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(FILES.map(scope)))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key.startsWith('snes-tracker-') && key !== CACHE).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || !request.url.startsWith(self.registration.scope)) return;
  if (request.mode === 'navigate') {
    // Pages: the network first, so an online visit always gets the newest
    // version; the cached page (or the tracker) when offline.
    event.respondWith(
      fetch(request).catch(() =>
        caches
          .open(CACHE)
          .then((cache) => cache.match(request, { ignoreSearch: true }).then((hit) => hit || cache.match(scope('./')))),
      ),
    );
    return;
  }
  // Assets have hashed names, so a cached copy is always the right one.
  event.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((response) => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          }),
      ),
    ),
  );
});
