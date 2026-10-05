import { version } from '$app/env';
import { assets, immutable, prerendered } from '$app/manifest';
import { self as serviceWorker } from '$app/service-worker';

const cachePrefix = 'shopping-list-shell-';
const cacheName = `${cachePrefix}${version}`;
const shellUrl = new URL('/', serviceWorker.location.origin).toString();

function shouldPrecacheAsset(path: string): boolean {
  return (
    path.endsWith('/manifest.webmanifest') ||
    path === 'manifest.webmanifest' ||
    path.endsWith('/favicon.svg') ||
    path === 'favicon.svg' ||
    path.includes('/icons/')
  );
}

const precacheUrls = Array.from(
  new Set([
    shellUrl,
    ...prerendered
      .filter((entry) => entry.path === '')
      .map((entry) =>
        new URL(entry.path, serviceWorker.location.origin).toString(),
      ),
    ...immutable.map((entry) =>
      new URL(entry.path, serviceWorker.location.origin).toString(),
    ),
    ...assets
      .filter((entry) => shouldPrecacheAsset(entry.path))
      .map((entry) =>
        new URL(entry.path, serviceWorker.location.origin).toString(),
      ),
  ]),
);
const precacheSet = new Set(precacheUrls);

serviceWorker.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(cacheName);
      await cache.addAll(precacheUrls);
      if (serviceWorker.registration.active) {
        const clients = await serviceWorker.clients.matchAll({
          type: 'window',
          includeUncontrolled: true,
        });
        for (const client of clients) {
          client.postMessage({ type: 'SHOPPING_LIST_UPDATE_READY' });
        }
      }
    })(),
  );
});

serviceWorker.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(cachePrefix) && name !== cacheName)
          .map((name) => caches.delete(name)),
      );
      await serviceWorker.clients.claim();
    })(),
  );
});

serviceWorker.addEventListener('message', (event) => {
  if (event.data?.type === 'SHOPPING_LIST_SKIP_WAITING') {
    void serviceWorker.skipWaiting();
  }
});

serviceWorker.addEventListener('fetch', (event) => {
  const request = event.request;
  const requestUrl = new URL(request.url);
  if (
    request.method !== 'GET' ||
    requestUrl.origin !== serviceWorker.location.origin ||
    requestUrl.pathname.startsWith('/api/')
  ) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const shell = await caches.match(shellUrl);
        return (
          shell ??
          new Response('Connect to load the application.', { status: 503 })
        );
      }),
    );
    return;
  }

  if (precacheSet.has(requestUrl.toString())) {
    event.respondWith(
      (async () => (await caches.match(request)) ?? fetch(request))(),
    );
  }
});
