// Network Status — second first-party desktop widget.
//
// Shows connectivity and latency from GET /api/network/stats
// (src/handlers/network.rs). IMPORTANT semantics: latency_ms is the Orion OS
// SERVER's round-trip to a fixed server-configured endpoint — not the user's
// browser ping — so the widget labels it "Network latency" and, in a subtitle,
// "server → network". The backend is the source of truth.
//
// Three distinct backend/transport states are kept separate:
//   1. API request itself failed        → "Offline · retrying" (transport), last values kept
//   2. backend reports online: false    → "Offline" (no connectivity), latency "—"
//   3. backend online but latency null   → "Online", latency "—"
//
// Polls on a fixed interval, never overlaps requests, clears its timer on
// destroy. The backend already caches/rate-limits the real probe.

import { h } from '../core/dom.js';
import { icons } from '../core/icons.js';
import { api } from '../core/api.js';

const POLL_MS = 3000; // the backend re-probes at most every 20s; this is well under

const latencyText = (ms) => (typeof ms === 'number' && isFinite(ms) && ms >= 0 ? `${Math.round(ms)} ms` : '—');

export const netmon = {
  id: 'netmon',

  mount(root) {
    const dot = h('span.netmon-dot');
    const label = h('span.netmon-label', '—');
    const value = h('b.netmon-value', '—');

    const header = h('div.netmon-head',
      h('span.netmon-title', h('span.netmon-ico', { html: icons.signal }), 'Network'),
    );
    const state = h('div.netmon-state', dot, label);
    const metric = h('div.netmon-metric',
      h('span.netmon-metric-label', 'Network latency'),
      value,
    );
    const note = h('div.netmon-note', 'server → network');

    root.append(h('div.netmon', header, state, metric, note));

    let timer = 0;
    let inFlight = false;
    let disposed = false;
    let haveData = false;

    // kind: 'online' | 'offline' | 'transport' | 'wait'
    function setState(kind, text) {
      dot.dataset.kind = kind;
      label.textContent = text;
    }

    function render(stats) {
      haveData = true;
      if (stats?.online === true) {
        setState('online', 'Online');
        value.textContent = latencyText(stats.latency_ms); // null → "—" (measurement unavailable)
      } else {
        // backend explicitly reports no connectivity
        setState('offline', 'Offline');
        value.textContent = '—';
      }
    }

    async function poll() {
      if (disposed || inFlight) return;
      inFlight = true;
      try {
        const stats = await api.get('/network/stats');
        if (disposed) return;
        render(stats);
      } catch {
        if (disposed) return;
        // Distinct from a backend-reported offline: the API itself is
        // unreachable. Keep the last known values if we have them.
        setState('transport', haveData ? 'Offline · retrying' : 'Unavailable');
      } finally {
        inFlight = false;
      }
    }

    setState('wait', 'Checking…');
    poll();
    timer = setInterval(poll, POLL_MS);

    return () => {
      disposed = true;
      clearInterval(timer);
    };
  },
};
