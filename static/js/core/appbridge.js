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

export function initAppBridge() {
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.source !== 'ltf-app') return;
    const ctx = senderApp(e.source);
    if (!ctx) return; // unknown / untrusted sender
    const app = registry.get(ctx.appId);

    if (d.type === 'hello') {
      e.source.postMessage(
        { source: 'ltf-host', type: 'app', app: { id: ctx.appId, name: app?.name || ctx.appId, version: app?.version || null } },
        location.origin,
      );
    } else if (d.type === 'open') {
      if (typeof d.url === 'string' && /^https?:\/\//i.test(d.url)) wm.open('orion', { url: d.url });
    } else if (d.type === 'notify') {
      const title = String(d.title || '').slice(0, NOTIFY_TITLE_MAX) || (app?.name || 'App');
      const body = String(d.body || '').slice(0, NOTIFY_BODY_MAX);
      notify(title, body);
    }
  });
}
