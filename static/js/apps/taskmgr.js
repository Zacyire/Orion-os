// Task Manager — live metrics streamed over the kernel WebSocket.
import { h } from '../core/dom.js';
import { icons } from '../core/icons.js';
import { sparkline } from '../core/widgets.js';
import { wm } from '../core/wm.js';

export default {
  single: true,

  mount(root, ctx) {
    const hist = { cpu: Array(60).fill(0), ram: Array(60).fill(0), gpu: Array(60).fill(0), net: Array(60).fill(0) };
    const mk = (key, label) => {
      const big = h('div.big', '–');
      const sub = h('small.muted', '');
      const canvas = h('canvas');
      return { key, big, sub, canvas, el: h('div.card.tm-card', h('b', label), big, sub, canvas) };
    };
    const cards = [mk('cpu', 'CPU'), mk('ram', 'Memory'), mk('gpu', 'GPU'), mk('net', 'Network')];
    const coresEl = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: '4px', marginTop: '8px' } });
    const procBody = h('tbody');
    root.append(h('div.app', h('div.app-main',
      h('h1.page-title', 'Performance'),
      h('div.tm-grid', cards.map((c) => c.el)),
      h('div.section-title', 'Logical processors'), coresEl,
      h('div.section-title', 'Apps'),
      h('table.tm-table', h('thead', h('tr', h('th', 'Name'), h('th', 'Window'), h('th', 'Status'), h('th', ''))), procBody),
    )));

    function renderProcs() {
      procBody.replaceChildren(...wm.list.map((w) => h('tr',
        h('td', w.app.name), h('td.muted', w.title), h('td.muted', w.minimized ? 'Suspended' : wm.focusedId === w.id ? 'Foreground' : 'Running'),
        h('td', w.id === ctx.win.id ? null : h('button.btn', { onclick: () => wm.close(w.id), html: icons.close }, 'End task')),
      )));
    }

    const offM = ctx.bus.on('server:metrics', (m) => {
      const ramPct = (m.ram_used_mb / m.ram_total_mb) * 100;
      const net = m.net_down_kbps + m.net_up_kbps;
      const vals = { cpu: m.cpu, ram: ramPct, gpu: m.gpu, net: Math.min(100, net / 120) };
      for (const k in hist) { hist[k].push(vals[k]); hist[k].shift(); }
      cards[0].big.textContent = `${m.cpu.toFixed(0)}%`;
      cards[0].sub.textContent = `${m.cores.length} cores · ${m.temp_c.toFixed(0)}°C · ${m.processes} processes`;
      cards[1].big.textContent = `${(m.ram_used_mb / 1024).toFixed(1)} GB`;
      cards[1].sub.textContent = `of ${(m.ram_total_mb / 1024).toFixed(0)} GB (${ramPct.toFixed(0)}%)`;
      cards[2].big.textContent = `${m.gpu.toFixed(0)}%`;
      cards[2].sub.textContent = 'RTX 4090 (virtual)';
      cards[3].big.textContent = `${(net / 1024).toFixed(2)} MB/s`;
      cards[3].sub.textContent = `↓ ${(m.net_down_kbps / 1024).toFixed(2)}  ↑ ${(m.net_up_kbps / 1024).toFixed(2)} MB/s`;
      cards.forEach((c) => sparkline(c.canvas, hist[c.key]));
      coresEl.replaceChildren(...m.cores.map((c, i) => h('div.card', { style: { padding: '6px', textAlign: 'center', fontSize: '11px', background: `linear-gradient(to top, var(--accent-soft) ${c}%, transparent ${c}%)` } }, `#${i}`, h('br'), `${c.toFixed(0)}%`)));
    });
    const offW = ctx.bus.on('wm:changed', renderProcs);
    renderProcs();
    return () => { offM(); offW(); };
  },
};
