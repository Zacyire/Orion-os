// LTF App API — host bridge.
//
// Listens for postMessage requests from app frames that include /ltf-api.js and
// performs a tiny, non-privileged set of actions using existing OS facilities
// (Orion for opening URLs, the toast system for notifications).
//
// Security boundary:
// * A message is honored ONLY if its source is one of our app iframes AND that
//   iframe is same-origin (first-party) and not a /proxy/ (isolated) frame.
//   Cross-origin and proxied/untrusted frames are ignored — the API is simply
//   unavailable there, isolation is never weakened.
// * The only data sent back to an app is its OWN public metadata (id, name,
//   version). No window manager, registry, store, backend or other-app data is
//   ever exposed. Inputs are validated (http(s) only) and length-capped.
//
// The request handlers are grouped by capability so new, equally safe APIs can
// be added without touching the gate or the existing groups:
//
//   appbridge
//     ├── metadata       — hello → the app's own { id, name, version, permissions }
//     ├── navigation     — open(url) → Orion          [requires "open-external"]
//     ├── notifications  — notify(title, body) → toast [requires "notifications"]
//     └── storage        — get/set/remove/clear        [requires "storage"]
//
// Each entry is { perm?, run(msg, ctx) } where ctx = { source, appId, app,
// granted }. `granted` is computed centrally from the calling app's MANIFEST
// permissions (host-controlled registry, never the message). Fire-and-forget
// handlers (notify/open) simply return when not granted; request/reply handlers
// (storage) send a safe rejection instead. Adding a capability means adding one
// entry — the gate and permission source are shared.

import { wm } from './wm.js';
import { registry } from './registry.js';
import { notify } from './notify.js';
import { appStorage, validKey } from './appstorage.js';

const NOTIFY_TITLE_MAX = 120;
const NOTIFY_BODY_MAX = 400;

/** Resolve the first-party app frame that sent a message, or null. */
function senderApp(source) {
  for (const iframe of document.querySelectorAll('#windows .window iframe')) {
    if (iframe.contentWindow !== source) continue;
    const src = iframe.getAttribute('src') || '';
    let sameOrigin = false;
    try { sameOrigin = new URL(src, location.href).origin === location.origin; } catch { /* opaque */ }
    if (!sameOrigin || src.startsWith('/proxy/')) return null; // not a first-party app frame
    const appId = iframe.closest('.window')?.dataset.app;
    return appId ? { appId } : null;
  }
  return null;
}

// ── metadata ──────────────────────────────────────────────────────────────
// Reply with the requesting app's OWN public metadata only (including its
// granted permission ids, so the app can adapt its UI). Nothing else about the
// OS or other apps is ever disclosed. No permission is required to learn one's
// own identity.
function handleHello(_msg, { source, app, appId }) {
  source.postMessage(
    {
      source: 'ltf-host',
      type: 'app',
      app: {
        id: appId,
        name: app?.name || appId,
        version: app?.version || null,
        permissions: registry.permissions(appId),
      },
    },
    location.origin,
  );
}

// ── navigation ──────────────────────────────────────────────────────────────
// Open an external URL in the Orion browser. http(s) only; anything else is
// ignored (never a javascript:/data:/file: navigation).
function handleOpen(msg, { granted }) {
  if (!granted) return; // missing "open-external" → safely ignored
  if (typeof msg.url === 'string' && /^https?:\/\//i.test(msg.url)) wm.open('orion', { url: msg.url });
}

// ── notifications ────────────────────────────────────────────────────────────
// Show an in-OS toast. Title/body are coerced to strings and length-capped;
// the title falls back to the app's name.
function handleNotify(msg, { app, granted }) {
  if (!granted) return; // missing "notifications" → safely ignored
  const title = String(msg.title || '').slice(0, NOTIFY_TITLE_MAX) || (app?.name || 'App');
  const body = String(msg.body || '').slice(0, NOTIFY_BODY_MAX);
  notify(title, body);
}

// ── storage ───────────────────────────────────────────────────────────────
// Per-app persistent key/value storage. Request/reply: the app awaits a Promise
// keyed by `rid`; the host answers with { type:'storage-result', rid, ok, ... }.
// The namespace is ALWAYS the host-identified appId — an app-supplied id or
// permission in the message is never read, so an app can neither reach another
// app's data nor grant itself the capability. A denied or failed op resolves to
// a safe rejection, never a host crash.
function handleStorage(msg, { source, appId, granted }) {
  const rid = msg.rid;
  const reply = (ok, value, error) =>
    source.postMessage({ source: 'ltf-host', type: 'storage-result', rid, ok, value, error }, location.origin);

  if (!granted) return reply(false, undefined, 'permission denied: storage');

  try {
    switch (msg.op) {
      case 'get':
        if (!validKey(msg.key)) return reply(false, undefined, 'invalid key');
        return reply(true, appStorage.get(appId, msg.key)); // value or null
      case 'set':
        if (!validKey(msg.key)) return reply(false, undefined, 'invalid key');
        appStorage.set(appId, msg.key, msg.value);
        return reply(true, true);
      case 'remove':
        if (!validKey(msg.key)) return reply(false, undefined, 'invalid key');
        appStorage.remove(appId, msg.key);
        return reply(true, true);
      case 'clear':
        appStorage.clear(appId);
        return reply(true, true);
      default:
        return reply(false, undefined, 'unknown storage op');
    }
  } catch (err) {
    return reply(false, undefined, err.message || 'storage error');
  }
}

// A handler may declare a required capability (`perm`); `granted` is computed
// centrally and passed in. `hello` needs none.
const handlers = {
  hello: { run: handleHello },
  open: { perm: 'open-external', run: handleOpen },
  notify: { perm: 'notifications', run: handleNotify },
  storage: { perm: 'storage', run: handleStorage },
};

export function initAppBridge() {
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.source !== 'ltf-app') return;
    const ctx = senderApp(e.source);
    if (!ctx) return; // unknown / untrusted sender
    const handler = handlers[d.type];
    if (!handler) return;
    // Permission comes from the host-controlled manifest, never the message, so
    // an app can never grant itself a capability.
    const granted = !handler.perm || registry.hasPermission(ctx.appId, handler.perm);
    handler.run(d, { source: e.source, appId: ctx.appId, app: registry.get(ctx.appId), granted });
  });
}
