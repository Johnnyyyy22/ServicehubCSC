/**
 * ServiceHub offline service worker.
 *
 * Strategy: runtime caching, not a build-time precache manifest. This app's
 * build pipeline (TanStack Start + Nitro, Cloudflare target) content-hashes
 * every JS/CSS filename on each deploy, so a hand-maintained or generated
 * precache list would go stale the moment anything changes. Instead, this
 * worker caches things AS they're fetched during normal use — so once an
 * engineer has opened the app while online, the exact files their browser
 * actually loaded are cached and will keep working with zero connectivity.
 *
 * - Navigation requests (the login page, /dispatch): network-first, so
 *   engineers get the latest version whenever they have signal, falling
 *   back to the last cached copy the moment the network fails.
 * - Same-origin static assets (hashed JS/CSS, the logo, favicon): cache-
 *   first. These filenames change on every deploy, so a cached one is safe
 *   to reuse forever — a stale filename simply won't be requested again.
 * - Anything cross-origin (script.google.com) is left alone entirely. The
 *   app's own offline queue (see dispatch-store.ts) already handles those
 *   failures; a service worker cache would only add a second, conflicting
 *   layer of staleness on top of live dispatch data.
 *
 * CACHE_VERSION: bump this string on any deploy where old cached assets
 * should be dropped. Old-versioned caches are deleted on activate.
 */
const CACHE_VERSION = "servicehub-v1";
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const ASSET_CACHE = `${CACHE_VERSION}-assets`;

// The two documents an engineer needs to be able to open with zero
// connectivity. Pre-warmed on install so even a first-ever offline visit
// (after at least one online load) has something to fall back to.
const SHELL_URLS = ["/", "/dispatch"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Best-effort: don't fail install if one of these can't be reached
      // right now (e.g. installing while already offline).
      await Promise.allSettled(
        SHELL_URLS.map((url) =>
          cache.add(new Request(url, { cache: "reload" })),
        ),
      );
    })(),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(
            (key) =>
              key.startsWith("servicehub-") && !key.startsWith(CACHE_VERSION),
          )
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle GET requests on our own origin. Everything else (the
  // Apps Script POSTs, cross-origin fetches) passes through untouched.
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // Navigation (the actual page load) — network-first, cache as a fallback.
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(SHELL_CACHE);
          cache.put(req, fresh.clone());
          return fresh;
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          const cached =
            (await cache.match(req)) ??
            (await cache.match("/dispatch")) ??
            (await cache.match("/"));
          if (cached) return cached;
          return new Response(
            "<!doctype html><title>Offline</title><body style='font-family:system-ui;padding:2rem;color:#e9e9ed;background:#161826'>No connection, and this page hasn't loaded before on this device. Connect once, then it'll work offline.</body>",
            { status: 200, headers: { "Content-Type": "text/html" } },
          );
        }
      })(),
    );
    return;
  }

  // Static assets (hashed JS/CSS/images) — cache-first, since a given
  // filename's content never changes once built.
  if (
    url.pathname.startsWith("/assets/") ||
    /\.(?:js|css|png|jpg|jpeg|svg|webp|ico|woff2?)$/.test(url.pathname)
  ) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSET_CACHE);
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const fresh = await fetch(req);
          if (fresh.ok) cache.put(req, fresh.clone());
          return fresh;
        } catch {
          // Nothing cached and no network — let it fail normally.
          throw new Error("offline and not cached");
        }
      })(),
    );
  }
});
