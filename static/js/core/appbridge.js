// Orion OS App API — host bridge.
//
// Serves `window.ltf` (static/ltf-api.js) to first-party app frames using
// existing OS facilities (Orion for URLs, toasts, per-app storage, the WM).
//
// Caller authentication (Step 21):
// 1. The window-level `message` channel accepts ONE thing: `hello`.
// 2. A hello is honoured only if `event.source` is the contentWindow of an
//    iframe inside a registered app window (browser-enforced, unforgeable), the
//    iframe is meant to host first-party content (same-origin src, not
//    /proxy/), AND `event.origin` — the real origin of the document that sent
//    it, also set by the browser — is this shell's origin. A frame that has
//    navigated elsewhere, a foreign/opaque document, or any other window gets
//    nothing. The iframe `src` alone is never trusted.
// 3. The host then transfers a fresh MessageChannel port to that exact
//    document (targetOrigin = the verified origin). The port is an unguessable
//    object capability bound to (app, window, iframe): every API request must
//    arrive on it; window-level requests other than hello are ignored.
// 4. The port is closed when the window closes, the iframe leaves the DOM, or
//    the frame says hello again (reload / new document) — a stale port can't act.
// Opaque-origin (sandboxed) frames are REJECTED: `event.origin` is "null" for
// every opaque document, so it can't authenticate anything. Vapor Phase C will
// add an explicit package clause (docs/vapor-architecture.md §7); the port
// transport already avoids the targetOrigin problem such frames would have.
//
// The only data sent to an app is its OWN public metadata (id, name, version,
// permissions). No WM, registry, store, backend or other-app data is exposed.
// Inputs are validated (http(s) only) and length-capped.
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
// Each entry is { perm?, run(msg, ctx) } where ctx = { post, appId, winId,
// app, granted }. `granted` is computed centrally from the calling app's
// MANIFEST permissions (host-controlled registry, never the message). The app
// id and window come from the authenticated port binding — an app can never
// name another app or another window. `post` replies on that port.

import { wm } from './wm.js';
import { registry } from './registry.js';
import { notify } from './notify.js';
import { bus } from './events.js';
import { appStorage, validKey } from './appstorage.js';

const NOTIFY_TITLE_MAX = 120;
const NOTIFY_BODY_MAX = 400;

// Windows subscribed to lifecycle events, keyed by the HOST window id:
//   winId → { post, last: "min|max|focus" signature }
// Pruned when the window no longer exists or its connection is replaced.
const winSubs = new Map();

// Live authenticated connections, keyed by iframe element:
//   iframe → { port, appId, winId, iframe }
const connections = new Map();
// Handshakes that passed authentication (test introspection only).
let acceptedHandshakes = 0;

/** The registered app window hosting `source`, or null. Identity comes from
 *  the browser (`contentWindow === event.source`), never from the message. */
function frameFor(source) {
  if (!source) return null;
  for (const iframe of document.querySelectorAll('#windows .window iframe')) {
    if (iframe.contentWindow !== source) continue;
    const winEl = iframe.closest('.window');
    const appId = winEl?.dataset.app;
    const winId = winEl?.dataset.id;
    return appId && winId && registry.get(appId) ? { iframe, appId, winId } : null;
  }
  return null;
}

/** Origin a legitimate document in this frame must have, or null if the frame
 *  may not use the bridge at all. Today only first-party frames qualify. */
function expectedOrigin(frame) {
  const src = frame.iframe.getAttribute('src') || '';
  let sameOrigin = false;
  try { sameOrigin = new URL(src, location.href).origin === location.origin; } catch { /* malformed */ }
  if (!sameOrigin || src.startsWith('/proxy/')) return null;
  return location.origin;
}

function closeConnection(conn) {
  connections.delete(conn.iframe);
  if (winSubs.get(conn.winId)?.conn === conn) winSubs.delete(conn.winId);
  try { conn.port.close(); } catch { /* already closed */ }
}

/** Still bound to a live window/iframe? (Belt and braces: pruning also closes.) */
const isLive = (conn) => connections.get(conn.iframe) === conn && conn.iframe.isConnected && !!wm.stateOf(conn.winId);

// ── metadata ──────────────────────────────────────────────────────────────
// Reply with the requesting app's OWN public metadata only (including its
// granted permission ids, so the app can adapt its UI). Nothing else about the
// OS or other apps is ever disclosed. No permission is required to learn one's
// own identity.
function sendMetadata({ post, app, appId }) {
  post({
    source: 'ltf-host',
    type: 'app',
    app: {
      id: appId,
      name: app?.name || appId,
      version: app?.version || null,
      permissions: registry.permissions(appId),
    },
  });
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
function handleStorage(msg, { post, appId, granted }) {
  const rid = msg.rid;
  const reply = (ok, value, error) => post({ source: 'ltf-host', type: 'storage-result', rid, ok, value, error });

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
function handleWindow(msg, { post, conn, winId, granted }) {
  const rid = msg.rid;
  const reply = (ok, value, error) => post({ source: 'ltf-host', type: 'window-result', rid, ok, value, error });

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
      // Track this window for lifecycle events on this connection's port.
      winSubs.set(winId, { post, conn, last: signature(state) });
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
// centrally and passed in. (`hello` is the window-channel handshake, not a
// port request — see connect().)
const handlers = {
  open: { perm: 'open-external', run: handleOpen },
  notify: { perm: 'notifications', run: handleNotify },
  storage: { perm: 'storage', run: handleStorage },
  window: { perm: 'window', run: handleWindow },
};

/** Authenticated hello → fresh MessageChannel port bound to this document. */
function connect(e) {
  const frame = frameFor(e.source);
  if (!frame) return; // not a registered app frame
  const origin = expectedOrigin(frame);
  if (!origin || e.origin !== origin) return; // wrong/foreign/opaque document
  acceptedHandshakes++;

  const previous = connections.get(frame.iframe);
  if (previous) closeConnection(previous); // reload or new document: old port is dead

  const { port1, port2 } = new MessageChannel();
  const conn = { port: port1, appId: frame.appId, winId: frame.winId, iframe: frame.iframe };
  const post = (msg) => { try { port1.postMessage(msg); } catch { /* closed */ } };
  connections.set(frame.iframe, conn);
  port1.onmessage = (ev) => dispatch(ev.data, conn, post);
  // Deliver the port only to a document that still has the verified origin.
  e.source.postMessage({ source: 'ltf-host', type: 'connect' }, origin, [port2]);
  sendMetadata({ post, app: registry.get(conn.appId), appId: conn.appId });
}

function dispatch(d, conn, post) {
  if (!d || typeof d !== 'object' || d.source !== 'ltf-app' || !isLive(conn)) return;
  if (!Object.hasOwn(handlers, d.type)) return;
  const handler = handlers[d.type];
  // Permission comes from the host-controlled manifest, never the message, so
  // an app can never grant itself a capability.
  const granted = !handler.perm || registry.hasPermission(conn.appId, handler.perm);
  handler.run(d, { post, conn, appId: conn.appId, winId: conn.winId, app: registry.get(conn.appId), granted });
}

export function initAppBridge() {
  // The window channel carries only the handshake. Every other window-level
  // "request" — from anyone, including a registered frame — is ignored.
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (d && d.source === 'ltf-app' && d.type === 'hello') connect(e);
  });

  // Lifecycle events: the WM emits `wm:changed` on every focus / minimize /
  // maximize / restore / close transition. For each subscribed window we diff
  // its state and push an event on that window's port. Connections whose
  // window or iframe is gone are closed here — this is the cleanup path that
  // invalidates capabilities after an app is closed.
  bus.on('wm:changed', () => {
    for (const conn of [...connections.values()]) {
      if (!conn.iframe.isConnected || !wm.stateOf(conn.winId)) closeConnection(conn);
    }
    for (const [winId, sub] of winSubs) {
      const st = wm.stateOf(winId);
      if (!st || !isLive(sub.conn)) { winSubs.delete(winId); continue; }
      const sig = signature(st);
      if (sig === sub.last) continue;
      sub.last = sig;
      sub.post({ source: 'ltf-host', type: 'window-event', state: st });
    }
  });

  // Top-window-only introspection for host-side tests. NOT reachable from any
  // app iframe (it lives on the OS window; apps only ever hold their own port).
  window.__ltfBridge = {
    windowSubscriptionCount: () => winSubs.size,
    connectionCount: () => connections.size,
    acceptedHandshakes: () => acceptedHandshakes,
  };
}
