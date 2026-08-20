// JUST CHILL — minimal service worker.
//
// Its only job is to exist, which is what makes Chrome treat this site as a
// real installable app (and what PWABuilder needs for TWA packaging).
//
// It deliberately does no offline caching. This app's whole point is live
// telemetry from a jacket, and serving a cached body temperature from an hour
// ago would be worse than showing nothing.
//
// Note there is no 'fetch' handler at all. The previous version registered one
// that did `event.respondWith(fetch(event.request))` — a pass-through that is
// not a no-op: it routes every request through the worker, which breaks
// request bodies and range requests on some browsers and adds latency for
// nothing. Omitting the handler entirely lets the browser use its normal
// network path, and installability does not require one.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
