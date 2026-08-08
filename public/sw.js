// A service worker that deliberately caches nothing.
//
// Chrome will not offer to install a page as an app unless a service worker
// with a fetch handler is controlling it. That is the only reason this file
// exists, and it is worth being blunt about the alternative: a caching worker
// in front of a terminal is a way to serve a stale bundle to a live session,
// and "reload harder" is not a debugging step anyone enjoys discovering.
//
// So the fetch handler is a passthrough. Every request goes to the network
// exactly as it would with no worker at all, and the app is installable.
//
// If offline support is ever wanted it belongs here, but it needs a real answer
// for the asset hashes in dist/web and for the API — not a cache-first sweep.

self.addEventListener("install", () => {
  // Take over immediately rather than waiting for every tab to close, so an
  // updated worker is never a version behind the page that fetched it.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  // Present, and doing nothing on purpose. Not calling respondWith leaves the
  // request to the browser, which is exactly the behaviour we want.
  void event;
});
