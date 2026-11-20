// The app shell offline (docs/engine-web.md "Offline"): network first, the last good copy when the
// network fails. Same-origin GETs only. Skipped: range requests (the PMTiles map tiles) and the region
// graph files, which the engine worker caches itself (one Cache API cache per graph build).
// Registered by src/main.tsx in production builds; it never claims an open page, so the first visit
// runs without it and later loads go through it.
const CACHE = "kompass-app-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names.filter((n) => n.startsWith("kompass-app-") && n !== CACHE).map((n) => caches.delete(n)),
        ),
      ),
  );
});

/** @param {Request} request */
function handled(request) {
  if (request.method !== "GET" || request.headers.has("range")) return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  return !/\/graph\/.*\.kmpg(\.gz)?$/.test(url.pathname) && !url.pathname.endsWith(".pmtiles");
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (!handled(request)) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(request);
        if (response.ok && response.type === "basic") void cache.put(request, response.clone());
        return response;
      } catch (error) {
        const hit = await cache.match(request, { ignoreSearch: request.mode === "navigate" });
        if (hit) return hit;
        throw error;
      }
    })(),
  );
});
