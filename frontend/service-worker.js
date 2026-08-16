/* service-worker.js — offline-first mode for a Sales Executive, SECTION 14.
 *
 * Not unit-tested (see src/test/logic.test.js's own comment on this file):
 * a ServiceWorkerGlobalScope, the Cache API and the fetch-event lifecycle
 * don't exist in Node, and there is no browser test harness in this project
 * to run one in. The QUEUE this offline mode writes into for a rep's own
 * new-buyer/new-reservation/log-activity submissions lives in
 * offline-queue.js instead, specifically because its logic (queue-entry
 * shape, sync order, status summary) is pure enough to test there.
 *
 * Registered from index.html, scoped to the whole app.
 *
 * TWO CACHES, TWO STRATEGIES:
 *   - App shell (HTML/CSS/JS): cache-first. This is the same three files on
 *     every visit; serving them from the cache instead of the network is a
 *     speed win even on a good connection, and the only way the app boots
 *     at all with no signal.
 *   - A rep's own data (their buyers, their reservations, the unit list for
 *     projects they work on): network-first, falling back to the cache when
 *     the network fails. Correctness matters more than speed for this one —
 *     a stale buyer list is fine to fall back to, but should never be
 *     preferred over a fresh one just because the cache is faster.
 *
 * Every other request (payments, settings, anything not explicitly listed
 * below) passes straight through with no caching at all — offline mode is
 * for VIEWING a rep's own book and QUEUEING three specific writes, not a
 * general-purpose offline replica of the whole product.
 */

var SHELL_CACHE = 'archta-shell-v1';
var DATA_CACHE = 'archta-data-v1';
var CACHE_TTL_MS = 24 * 60 * 60 * 1000;

var APP_SHELL = [
  './',
  './index.html',
  './realestate.css',
  './config.js',
  './realestate.js',
  './offline-queue.js',
  './screens.js',
  // TASK 2.17 — the buyer's two standalone pages share this same cache
  // (they load realestate.css, already listed above) but weren't
  // themselves precached, so opening one straight from a cold cache miss
  // (no signal, a link opened from an old WhatsApp message) failed exactly
  // where the operator app's own shell already worked.
  './portal.html',
  './portal.js',
  './sign.html',
  './sign.js',
];

// Only a Sales Executive's own three lists (CLAUDE.md's role model: "THEIR
// OWN buyers and reservations only") plus the unit list every role reads —
// caching more than this would quietly start offering an out-of-date view
// of screens (payments, settings, reports) where staleness is actually
// dangerous, not just inconvenient.
var CACHEABLE_DATA_PATTERNS = [
  /\/api\/re\/customers(\?|$)/,
  /\/api\/re\/reservations(\?|$)/,
  /\/api\/re\/units(\?|$)/,
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(function (cache) { return cache.addAll(APP_SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (names) {
        return Promise.all(
          names
            .filter(function (name) { return name !== SHELL_CACHE && name !== DATA_CACHE; })
            .map(function (name) { return caches.delete(name); })
        );
      })
      .then(function () { return self.clients.claim(); })
  );
});

function isShellRequest(url) {
  return url.origin === self.location.origin && !url.pathname.includes('/api/');
}

function isCacheableData(url) {
  var full = url.pathname + url.search;
  return CACHEABLE_DATA_PATTERNS.some(function (pattern) { return pattern.test(full); });
}

// Stamps the response with when it was cached, since the plain Cache API
// has no TTL of its own — this is what cache-hit staleness (below) reads
// back to decide whether a 25-hour-old buyer list is still worth serving.
function withCachedAtHeader(response) {
  return response.blob().then(function (body) {
    var headers = new Headers(response.headers);
    headers.set('x-archta-cached-at', String(Date.now()));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: headers });
  });
}

function isFresh(cachedResponse) {
  var stamp = Number(cachedResponse.headers.get('x-archta-cached-at') || 0);
  return stamp > 0 && (Date.now() - stamp) < CACHE_TTL_MS;
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return; // POST/PATCH/DELETE always go straight to the network — see this file's header

  var url = new URL(request.url);

  if (isShellRequest(url)) {
    event.respondWith(
      caches.match(request).then(function (cached) {
        if (cached) return cached;
        return fetch(request).then(function (response) {
          var copy = response.clone();
          caches.open(SHELL_CACHE).then(function (cache) { cache.put(request, copy); });
          return response;
        });
      })
    );
    return;
  }

  if (isCacheableData(url)) {
    event.respondWith(
      fetch(request)
        .then(function (response) {
          if (response.ok) {
            withCachedAtHeader(response.clone()).then(function (stamped) {
              caches.open(DATA_CACHE).then(function (cache) { cache.put(request, stamped); });
            });
          }
          return response;
        })
        .catch(function () {
          return caches.open(DATA_CACHE).then(function (cache) {
            return cache.match(request).then(function (cached) {
              // Served even once past the 24h TTL — a day-old buyer list
              // offline beats no buyer list at all; isFresh only decides
              // whether the PAGE marks it "may be out of date", via the
              // x-archta-cached-at header it can read off the same response.
              return cached || new Response(JSON.stringify({ error: 'Offline and nothing cached yet.' }), {
                status: 503,
                headers: { 'Content-Type': 'application/json' },
              });
            });
          });
        })
    );
    return;
  }

  // Everything else: no caching, straight through.
});

// SECTION 1 — browser push. The payload is exactly what pushService.js's
// notify() sends: { title, body, url }. A malformed/empty payload (some
// push services deliver an empty "wake up and check" ping with no data)
// still shows something rather than silently doing nothing, which on some
// platforms is what makes the browser start showing its own generic
// "this site has been updated" notification instead.
self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (err) { data = {}; }

  var title = data.title || 'Archta';
  var options = {
    body: data.body || '',
    icon: './apple-touch-icon.png',
    data: { url: data.url || './' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Focuses an already-open tab rather than always opening a new one — a
// notification arriving while the app is already open in another tab
// should not pile up duplicate tabs every time one is clicked.
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || './';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if ('focus' in client) {
          if ('navigate' in client) client.navigate(url);
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
