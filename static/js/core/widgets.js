// Desktop widgets host — the small seam first-party widgets mount through.
//
// A widget is a module exporting: { id, mount(root) → cleanup | { destroy } }.
// `mount` builds its own element inside `root` and returns a teardown so the
// host can stop timers/requests. Widgets live in the #widgets layer, which
// sits above the wallpaper/icons but below application windows.
//
// This is deliberately minimal: adding another first-party widget later means
// adding its module to WIDGETS below, not touching desktop/window code. It is
// NOT a general widget framework (no drag layout, no persistence, no SDK).

import { $ } from './dom.js';
import { sysmon } from '../widgets/sysmon.js';

// First-party widgets shown on the desktop, in mount order.
const WIDGETS = [sysmon];

let root = null;
const mounted = [];

export const widgets = {
  init() {
    root = $('#widgets');
    if (!root) return;
    for (const widget of WIDGETS) {
      const host = document.createElement('div');
      host.className = 'widget';
      host.dataset.widget = widget.id;
      root.append(host);
      try {
        const teardown = widget.mount(host);
        mounted.push({ host, teardown });
      } catch (err) {
        // A broken widget must never take down the desktop.
        console.error(`[widgets] "${widget.id}" failed to mount`, err);
        host.remove();
      }
    }
  },

  /** Tear every widget down (timers, listeners). Not used at runtime yet; kept for tests/cleanup. */
  destroyAll() {
    for (const { host, teardown } of mounted.splice(0)) {
      try { (typeof teardown === 'function' ? teardown : teardown?.destroy)?.(); } catch { /* ignore */ }
      host.remove();
    }
  },
};
