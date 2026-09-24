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
//     ├── storage        — get/set/remove/clear        [requires "storage"]
//     └── window         — getState/min/max/restore +  [requires "window"]
//                          onStateChange lifecycle events for the app's OWN window
//
// Each entry is { perm?, run(msg, ctx) } where ctx = { source, appId, winId,
// app, granted }. `granted` is computed centrally from the calling app's
// MANIFEST permissions (host-controlled registry, never the message). Both the
// app id AND the target window are resolved by the host from the sending iframe
// (senderApp) — an app can never name another app or another window. Adding a
// capability means adding one entry — the gate and permission source are shared.

import { wm } from './wm.js';
import { registry } from './registry.js';
import { notify } from './notify.js';
import { bus } from './events.js';
import { appStorage, validKey } from './appstorage.js';

const NOTIFY_TITLE_MAX = 120;
const NOTIFY_BODY_MAX = 400;

// Windows subscribed to lifecycle events, keyed by the HOST window id:
//   winId → { source: iframe contentWindow, last: "min|max|focus" signature }
// Pruned automatically when a window no longer exists (see the wm:changed hook),
// so a closed app leaves no dangling listener.
const winSubs = new Map();

/**
 * Resolve the first-party app frame that sent a message, or null. Returns both
 * the registered app id and the HOST window id that owns the iframe — the app
 * never supplies either, so it can neither impersonate another app nor act on
 * another window.
 */
function senderApp(source) {
  for (const iframe of document.querySelectorAll('#windows .window iframe')) {
    if (iframe.contentWindow !== source) continue;
    const src = iframe.getAttribute('src') || '';
    let sameOrigin = false;
    try { sameOrigin = new URL(src, location.href).origin === location.origin; } catch { /* opaque */ }
    if (!sameOrigin || src.startsWith('/proxy/')) return null; // not a first-party app frame
    const winEl = iframe.closest('.window');
    const appId = winEl?.dataset.app;
    const winId = winEl?.dataset.id;
    return appId ? { appId, winId } : null;
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

// ── window ───────────────────────────────────────────────────────────────
// Lifecycle state + control for the app's OWN window. The target window is the
// host-resolved `winId` (from the sending iframe); an app-supplied window/app id
// is never honored. State is read via wm.stateOf() — no element, instance or
// internal WM object is ever exposed. Actions reuse the existing WM operations,
// so normal window behavior is unchanged.
function handleWindow(msg, { source, winId, granted }) {
  const rid = msg.rid;
  const reply = (ok, value, error) =>
    source.postMessage({ source: 'ltf-host', type: 'window-result', rid, ok, value, error }, location.origin);

  if (!granted) return reply(false, undefined, 'permission denied: window');
  const state = wm.stateOf(winId);
  if (!state) return reply(false, undefined, 'no window'); // no window owns this frame

  switch (msg.op) {
    case 'getState':
      return reply(true, state);
    case 'minimize':
      wm.minimize(winId);
      return reply(true, wm.stateOf(winId));
    case 'maximize':
      if (state.minimized) wm.restore(winId);         // make visible first
      if (!wm.stateOf(winId).maximized) wm.toggleMaximize(winId);
      return reply(true, wm.stateOf(winId));
    case 'restore':
      if (state.minimized) wm.restore(winId);         // un-minimize (+ focus)
      else if (state.maximized) wm.toggleMaximize(winId); // un-maximize
      return reply(true, wm.stateOf(winId));
    case 'subscribe':
      // Track this window for lifecycle events. Only first-party frames reach
      // here (senderApp gate), so cross-origin/proxy frames never subscribe.
      winSubs.set(winId, { source, last: signature(state) });
      return reply(true, state);
    case 'unsubscribe':
      winSubs.delete(winId);
      return reply(true, true);
    default:
      return reply(false, undefined, 'unknown window op');
  }
}

const signature = (s) => `${s.minimized}|${s.maximized}|${s.focused}`;

// A handler may declare a required capability (`perm`); `granted` is computed
// centrally and passed in. `hello` needs none.
const handlers = {
  hello: { run: handleHello },
  open: { perm: 'open-external', run: handleOpen },
  notify: { perm: 'notifications', run: handleNotify },
  storage: { perm: 'storage', run: handleStorage },
  window: { perm: 'window', run: handleWindow },
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
    handler.run(d, { source: e.source, appId: ctx.appId, winId: ctx.winId, app: registry.get(ctx.appId), granted });
  });

  // Lifecycle events: the WM already emits `wm:changed` on every focus /
  // minimize / maximize / restore / close transition. For each subscribed
  // window we diff its state and push an event to that window's own iframe.
  // A window that no longer exists is pruned here — this is the cleanup path
  // that prevents leaked listeners after an app is closed.
  bus.on('wm:changed', () => {
    for (const [winId, sub] of winSubs) {
      const st = wm.stateOf(winId);
      if (!st) { winSubs.delete(winId); continue; } // window gone → clean up
      const sig = signature(st);
      if (sig === sub.last) continue;
      sub.last = sig;
      try { sub.source.postMessage({ source: 'ltf-host', type: 'window-event', state: st }, location.origin); } catch { /* frame gone */ }
    }
  });

  // Top-window-only introspection for host-side tests. NOT reachable from any
  // app iframe (it lives on the OS window, which apps are cross-origin to).
  window.__ltfBridge = { windowSubscriptionCount: () => winSubs.size };
}
