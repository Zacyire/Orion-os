// System Monitor — the first first-party desktop widget.
//
// Shows live CPU, memory, uptime and platform from GET /api/system/stats
// (src/handlers/system.rs). The backend is the source of truth: this widget
// only renders what the endpoint returns and never measures the host itself.
//
// It polls on a fixed interval, keeps showing the last good values while a
// request is in flight, degrades to an unobtrusive offline state on failure,
// and resumes automatically when the API returns. Null metrics (e.g. CPU
// usage before the backend has two samples) render as "—", never a fake 0.

import { h } from '../core/dom.js';
import { icons } from '../core/icons.js';
import { api, isStatic } from '../core/api.js';

const POLL_MS = 2000; // modest: the backend re-samples CPU at most ~5×/s anyway

const pct = (v) => (typeof v === 'number' && isFinite(v) ? `${Math.round(v)}%` : '—');
const oneDp = (v) => (typeof v === 'number' && isFinite(v) ? v.toFixed(1) : '—');

/** Bytes → "12.3 GB" style, or "—" for null. */
function bytes(v) {
  if (typeof v !== 'number' || !isFinite(v)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = v;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/** Seconds → "3d 04h 12m" / "12m 30s" (null → "—"). */
function uptime(sec) {
  if (typeof sec !== 'number' || !isFinite(sec) || sec < 0) return '—';
  const d = Math.floor(sec / 86400);
  const hrs = Math.floor((sec % 86400) / 3600);
  const min = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${String(hrs).padStart(2, '0')}h ${String(min).padStart(2, '0')}m`;
  if (hrs > 0) return `${hrs}h ${String(min).padStart(2, '0')}m`;
  return `${min}m ${String(Math.floor(sec % 60)).padStart(2, '0')}s`;
}

/** used/total → percent, or null when either is missing. */
function memPercent(mem) {
  const used = mem?.used_bytes;
  const total = mem?.total_bytes;
  if (typeof used !== 'number' || typeof total !== 'number' || total <= 0) return null;
  return (used / total) * 100;
}

export const sysmon = {
  id: 'sysmon',

  mount(root) {
    // ── structure ──
    const dot = h('span.sysmon-dot');
    const status = h('span.sysmon-status', 'Starting…');
    const header = h('div.sysmon-head',
      h('span.sysmon-title', h('span.sysmon-ico', { html: icons.cpu }), 'System Monitor'),
      h('span.sysmon-state', dot, status),
    );

    const meter = (label, glyph) => {
      const fill = h('i');
      const val = h('b', '—');
      const bar = h('div.sysmon-bar', fill);
      return {
        el: h('div.sysmon-metric',
          h('div.sysmon-metric-top', h('span.sysmon-label', h('span', { html: icons[glyph] }), label), val),
          bar,
        ),
        set(percent, text) {
          const has = typeof percent === 'number' && isFinite(percent);
          const p = has ? Math.max(0, Math.min(100, percent)) : 0;
          fill.style.width = `${p}%`;
          fill.dataset.level = has ? (p >= 85 ? 'high' : p >= 60 ? 'mid' : 'low') : 'none';
          val.textContent = text;
        },
      };
    };

    const cpu = meter('CPU', 'cpu');
    const mem = meter('Memory', 'note');

    const memDetail = h('span', '—');
    const upDetail = h('span', '—');
    const platDetail = h('span', '—');
    const rows = h('dl.sysmon-facts',
      h('dt', h('span', { html: icons.note }), 'Memory'), h('dd', memDetail),
      h('dt', h('span', { html: icons.clock }), 'Uptime'), h('dd', upDetail),
      h('dt', h('span', { html: icons.bolt }), 'Platform'), h('dd', platDetail),
    );

    root.append(h('div.sysmon', header, cpu.el, mem.el, rows));

    // ── state ──
    let timer = 0;
    let inFlight = false;
    let disposed = false;
    let haveData = false;

    function setStatus(kind, text) {
      dot.dataset.kind = kind; // 'ok' | 'wait' | 'off'
      status.textContent = text;
    }

    function render(stats) {
      haveData = true;
      const usage = stats?.cpu?.usage_percent;
      cpu.set(usage, usage == null ? '—' : `${oneDp(usage)}%`);

      const mp = memPercent(stats?.memory);
      mem.set(mp, pct(mp));
      const used = stats?.memory?.used_bytes;
      const total = stats?.memory?.total_bytes;
      memDetail.textContent = used == null && total == null ? 'unavailable' : `${bytes(used)} / ${bytes(total)}`;

      upDetail.textContent = uptime(stats?.uptime_seconds);

      const os = stats?.platform?.os;
      const arch = stats?.platform?.arch;
      platDetail.textContent = os || arch ? `${os ?? '—'} · ${arch ?? '—'}` : 'unavailable';

      setStatus('ok', 'Live');
    }

    async function poll() {
      if (disposed || inFlight) return;
      inFlight = true;
      try {
        const stats = await api.get('/system/stats');
        if (disposed) return;
        render(stats);
      } catch {
        if (disposed) return;
        // Keep the last good values; just flag the connection.
        setStatus('off', haveData ? 'Offline · retrying' : 'Server unavailable');
      } finally {
        inFlight = false;
      }
    }

    // Static edition: there is no server to measure — say so, don't poll.
    if (isStatic) {
      setStatus('off', 'Server unavailable');
      return () => { disposed = true; };
    }
    setStatus('wait', 'Starting…');
    poll();
    timer = setInterval(poll, POLL_MS);

    return () => {
      disposed = true;
      clearInterval(timer);
    };
  },
};
