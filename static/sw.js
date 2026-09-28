// Orion OS service worker.
//
// Scope: "/" (same origin only). What it does — and deliberately doesn't:
//
//   Request                              Handling
//   ─────────────────────────────────    ─────────────────────────────────────────────
//   cross-origin (any)                   not intercepted — direct iframes and embeds talk
//                                        to their own origins; nothing is proxied implicitly
//   /api/*, /proxy/*, /ws                not intercepted — live data, isolated documents
//                                        (opaque-origin frames aren't SW-controlled anyway)
//   Range requests, .webm/.mp4/…         not intercepted — media streaming stays native
//   /net/<encoded-url>                   remote resources via the backend (src/web/fetch.rs):
//                                        cache-first for images/fonts (LRU, 7 days),
//                                        in-flight coalescing, SVG placeholder on failure
//   navigations (/)                      network-first, cached copy when offline
//   other same-origin GETs (JS/CSS/…)    network-first, cache fallback (offline shell)
//
// Loop safety: the SW's own fetch() calls are never routed back through the
// SW, and /net/ responses come from the server, not from another /net/ URL.
//
// Request lifecycle for a web-app (e.g. Netflix):
//   window opens → apps/webapp.js → core/frame.js → GET /api/web/inspect (bypasses SW)
//   → allowed: <iframe src="https://target/…"> (cross-origin: bypasses SW)
//   → the page's own requests go straight to its servers
//   → OS-side extras (favicons, thumbnails, data) use /net/… → this worker → backend

const VERSION = 'v3';
const SHELL_CACHE = `ltf-shell-${VERSION}`;
const NET_CACHE = 'ltf-net-v1';
const NET_MAX_ENTRIES = 300;
const NET_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const SHELL = ['/', '/index.html', '/apps.json', '/assets/logo.svg', '/js/app.js', '/css/system/tokens.css', '/css/system/base.css'];

const inflight = new Map();

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('ltf-shell-') && key !== SHELL_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;
  if (path.startsWith('/api/') || path.startsWith('/proxy/') || path === '/ws') return;
  if (req.headers.has('range') || /\.(webm|mp4|mov|m4v|mp3|ogg|m3u8|ts)$/i.test(path)) return;

  if (path.startsWith('/net/')) {
    event.respondWith(net(req));
  } else {
    event.respondWith(networkFirst(req));
  }
});

// ── /net/ ──────────────────────────────────────────────────────────────────
const cacheable = (res) => {
  const type = res.headers.get('content-type') || '';
  return res.ok && res.status === 200 && /^(image\/|font\/|application\/font|image\/svg)/.test(type);
};

async function net(req) {
  const cache = await caches.open(NET_CACHE);
  const hit = await cache.match(req);
  if (hit && Date.now() - Number(hit.headers.get('x-ltf-cached-at') || 0) < NET_MAX_AGE_MS) return hit;

  // Coalesce identical concurrent requests (e.g. many tabs asking for one favicon).
  if (inflight.has(req.url)) return (await inflight.get(req.url)).clone();
  const pending = (async () => {
    try {
      const res = await fetch(req);
      if (cacheable(res)) {
        const headers = new Headers(res.headers);
        headers.set('x-ltf-cached-at', String(Date.now()));
        const body = await res.clone().blob();
        await cache.put(req, new Response(body, { status: res.status, headers }));
        trim(cache);
      }
      if (!res.ok && req.destination === 'image') return hit || placeholder();
      return res;
    } catch {
      if (hit) return hit;
      return req.destination === 'image' ? placeholder() : errorJson('SERVER_ERROR', 'The Orion OS server is unreachable.');
    }
  })();
  inflight.set(req.url, pending);
  try {
    return (await pending).clone();
  } finally {
    inflight.delete(req.url);
  }
}

async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - NET_MAX_ENTRIES; i++) await cache.delete(keys[i]);
}

function placeholder() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9"><rect width="16" height="9" fill="#262833"/></svg>';
  return new Response(svg, { headers: { 'content-type': 'image/svg+xml', 'x-ltf-placeholder': '1' } });
}

function errorJson(code, message) {
  return new Response(JSON.stringify({ error: { code, message } }), { status: 503, headers: { 'content-type': 'application/json' } });
}

// ── shell ──────────────────────────────────────────────────────────────────
async function networkFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') cache.put(req.mode === 'navigate' ? '/' : req, res.clone());
    return res;
  } catch {
    return (await cache.match(req.mode === 'navigate' ? '/' : req)) || new Response('Offline', { status: 503 });
  }
}
