/*
 * Service worker - this is what lets the app open with no signal at all.
 *
 * Strategy: try the network first so a new version of the app lands as soon
 * as you have signal, but never wait more than NETWORK_TIMEOUT for it. If the
 * network is slow, dead, or you are offline, the cached copy answers instead.
 *
 * Read-only pages only. Anything that is not a GET is left alone, and nothing
 * here touches your saved data - that lives in IndexedDB, not in the cache.
 */

// Bump this whenever you change any of the files below. The new worker takes
// over on the next load and quietly drops the old cache.
var VERSION = 'watercalc-v7';


var SHELL = [
    './',
    './index.html',
    './style.css',
    './parser.js',
    './store.js',
    './app.js',
    './manifest.webmanifest',
    './icons/favicon-64.png',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/maskable-512.png',
    './icons/apple-touch-icon.png'
];

var NETWORK_TIMEOUT = 4000;

self.addEventListener('install', function (event) {
    event.waitUntil(
        caches.open(VERSION)
            .then(function (cache) {
                // addAll fails the whole install if one file 404s, so add
                // them one at a time and keep whatever we can
                return Promise.all(SHELL.map(function (url) {
                    return cache.add(new Request(url, { cache: 'reload' }))
                        .catch(function () { return null; });
                }));
            })
            .then(function () { return self.skipWaiting(); })
    );
});

self.addEventListener('activate', function (event) {
    event.waitUntil(
        caches.keys()
            .then(function (keys) {
                return Promise.all(keys.map(function (key) {
                    if (key === VERSION) return null;
                    return caches.delete(key);
                }));
            })
            .then(function () { return self.clients.claim(); })
    );
});

function fromNetwork(request) {
    return fetch(request).then(function (response) {
        // A flaky connection, a hotel wifi portal, or a dead proxy can all
        // answer with a 5xx while the phone still thinks it is "online".
        // That is not a real answer, so treat it as offline and use the cache.
        if (!response || response.status >= 500) {
            throw new Error('bad gateway: ' + (response ? response.status : 'no response'));
        }

        // Remember a good copy for next time we are offline
        if (response.status === 200 && response.type === 'basic') {
            var copy = response.clone();
            caches.open(VERSION).then(function (cache) {
                cache.put(request, copy).catch(function () { return null; });
            });
        }
        return response;
    });
}

function fromCache(request) {
    return caches.match(request, { ignoreSearch: true }).then(function (hit) {
        if (hit) return hit;
        // Last resort: the app shell, so a deep link still opens offline
        return caches.match('./index.html', { ignoreSearch: true });
    });
}

self.addEventListener('fetch', function (event) {
    var request = event.request;

    if (request.method !== 'GET') return;

    var url;
    try {
        url = new URL(request.url);
    } catch (err) {
        return;
    }

    if (url.origin !== self.location.origin) return;

    event.respondWith(new Promise(function (resolve) {
        var settled = false;

        function done(response) {
            if (settled) return;
            settled = true;
            resolve(response);
        }

        var timer = setTimeout(function () {
            // Network is dragging - serve what we have
            fromCache(request).then(done);
        }, NETWORK_TIMEOUT);

        fromNetwork(request).then(function (response) {
            clearTimeout(timer);
            done(response);
        }).catch(function () {
            clearTimeout(timer);
            fromCache(request).then(function (hit) {
                done(hit || new Response('Offline', {
                    status: 503,
                    headers: { 'Content-Type': 'text/plain' }
                }));
            });
        });
    }));
});
