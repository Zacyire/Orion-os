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
//     ├── metadata       — hello → the app's own { id, name, version }
//     ├── navigation     — open(url) → Orion
//     └── notifications  — notify(title, body) → toast
//
// Each handler receives (msg, ctx) where ctx = { source, app } and returns
// nothing; adding a capability means adding one entry to `handlers`.

import { wm } from './wm.js';
import { registry } from './registry.js';
import { notify } from './notify.js';

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
// Reply with the requesting app's OWN public metadata only. Nothing else about
// the OS or other apps is ever disclosed.
function handleHello(_msg, { source, app, appId }) {
  source.postMessage(
    { source: 'ltf-host', type: 'app', app: { id: appId, name: app?.name || appId, version: app?.version || null } },
    location.origin,
  );
}

// ── navigation ──────────────────────────────────────────────────────────────
// Open an external URL in the Orion browser. http(s) only; anything else is
// ignored (never a javascript:/data:/file: navigation).
function handleOpen(msg) {
  if (typeof msg.url === 'string' && /^https?:\/\//i.test(msg.url)) wm.open('orion', { url: msg.url });
}

// ── notifications ────────────────────────────────────────────────────────────
// Show an in-OS toast. Title/body are coerced to strings and length-capped;
// the title falls back to the app's name.
function handleNotify(msg, { app }) {
  const title = String(msg.title || '').slice(0, NOTIFY_TITLE_MAX) || (app?.name || 'App');
  const body = String(msg.body || '').slice(0, NOTIFY_BODY_MAX);
  notify(title, body);
}

const handlers = {
  hello: handleHello,
  open: handleOpen,
  notify: handleNotify,
};

export function initAppBridge() {
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.source !== 'ltf-app') return;
    const ctx = senderApp(e.source);
    if (!ctx) return; // unknown / untrusted sender
    const handler = handlers[d.type];
    if (!handler) return;
    handler(d, { source: e.source, appId: ctx.appId, app: registry.get(ctx.appId) });
  });
}
