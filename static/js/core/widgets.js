// Floating, draggable desktop widgets: clock, performance, weather, notes.

import { h, $, clamp, debounce, local } from './dom.js';
import { icons } from './icons.js';
import { bus } from './events.js';
import { store } from './store.js';
import { api } from './api.js';

const WIDTH = 280;
let layer;
const mounted = new Map(); // id → { el, destroy }

const DEFS = {
  clock: { title: 'Clock', icon: 'clock', build: clockWidget },
  perf: { title: 'Performance', icon: 'cpu', build: perfWidget },
  weather: { title: 'Weather', icon: 'cloudSun', build: weatherWidget },
  notes: { title: 'Quick notes', icon: 'note', build: notesWidget },
};

export const WIDGETS = Object.entries(DEFS).map(([id, d]) => ({ id, title: d.title, icon: d.icon }));

export const widgets = {
  init() {
    layer = $('#widgets');
    document.body.classList.toggle('widgets-hidden', local.get('widgetsHidden', false));
    bus.on('widgets:toggle', () => {
      const hidden = document.body.classList.toggle('widgets-hidden');
      local.set('widgetsHidden', hidden);
    });
    store.watch('widgets', () => this.sync());
    window.addEventListener('resize', () => this.sync());
    bus.on('taskbar:layout', () => setTimeout(() => this.sync(), 450));
    this.sync();
  },

  setVisible(id, visible) {
    store.set(`widgets.${id}.visible`, visible);
    if (visible) {
      document.body.classList.remove('widgets-hidden');
      local.set('widgetsHidden', false);
    }
  },

  sync() {
    const cfg = store.get('widgets') || {};
    let autoY = 16; // widgets never dragged stack down the right edge
    for (const [id, def] of Object.entries(DEFS)) {
      const c = cfg[id] || {};
      let m = mounted.get(id);
      if (!c.visible) {
        if (m) { m.destroy?.(); m.el.remove(); mounted.delete(id); }
        continue;
      }
      if (!m) {
        m = this._mount(id, def);
        mounted.set(id, m);
      }
      if (c.x == null || c.y == null) {
        this._place(m.el, { x: null, y: autoY });
        autoY += m.el.offsetHeight + 12;
      } else this._place(m.el, c);
    }
  },

  _mount(id, def) {
    const content = h('div');
    const head = h('div.widget-head',
      h('span', { html: icons[def.icon] }), h('span', def.title), h('span.spacer'),
      h('button', { html: icons.close, title: 'Hide widget', 'aria-label': 'Hide widget', onclick: () => this.setVisible(id, false) }),
    );
    const el = h(`div.widget.w-${id}`, { dataset: { widget: id } }, head, content);
    layer.append(el);
    head.addEventListener('pointerdown', (e) => this._drag(e, id, el));
    const destroy = def.build(content, id);
    // Content height can change (async weather, textarea resize) → restack.
    const ro = new ResizeObserver(() => this.sync());
    ro.observe(el);
    return { el, destroy: () => { ro.disconnect(); destroy?.(); } };
  },

  _place(el, c) {
    const W = layer.clientWidth;
    const H = layer.clientHeight;
    const w = el.offsetWidth || WIDTH;
    const x = c.x == null ? W - w - 24 : clamp(c.x, 0, Math.max(0, W - w));
    const y = clamp(c.y ?? 16, 0, Math.max(0, H - 60));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  },

  _drag(e, id, el) {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    const sx = e.clientX - el.offsetLeft;
    const sy = e.clientY - el.offsetTop;
    el.classList.add('dragging');
    const move = (ev) => {
      el.style.left = `${clamp(ev.clientX - sx, 0, layer.clientWidth - el.offsetWidth)}px`;
      el.style.top = `${clamp(ev.clientY - sy, 0, layer.clientHeight - 40)}px`;
    };
    const up = () => {
      el.classList.remove('dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      store.update('widgets', (wd) => {
        wd[id] = { ...wd[id], x: el.offsetLeft, y: el.offsetTop };
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  },
};

// ─── Clock ────────────────────────────────────────────────────────────────
function clockWidget(root, id) {
  const canvas = h('canvas.w-clock-analog', { width: 180, height: 180 });
  const digital = h('div.w-clock-digital');
  const date = h('div.w-clock-date');
  root.append(digital, canvas, date);
  root.title = 'Click to switch analog/digital';
  root.style.cursor = 'pointer';
  root.addEventListener('click', () => {
    const cur = store.get(`widgets.${id}.style`);
    store.set(`widgets.${id}.style`, cur === 'analog' ? 'digital' : 'analog');
  });

  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = canvas.height = 180 * dpr;
  canvas.style.width = canvas.style.height = '180px';
  const ctx = canvas.getContext('2d');

  const draw = () => {
    const now = new Date();
    const analog = store.get(`widgets.${id}.style`) === 'analog';
    canvas.hidden = !analog;
    digital.hidden = analog;
    date.textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    if (!analog) {
      const [hm, ampm] = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }).split(' ');
      digital.replaceChildren(hm, h('small', ampm || String(now.getSeconds()).padStart(2, '0')));
      return;
    }
    const cs = getComputedStyle(document.documentElement);
    const text = cs.getPropertyValue('--text').trim();
    const acc = cs.getPropertyValue('--accent').trim();
    ctx.setTransform(dpr, 0, 0, dpr, 90 * dpr, 90 * dpr);
    ctx.clearRect(-90, -90, 180, 180);
    ctx.strokeStyle = text;
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * Math.PI * 2;
      const len = i % 5 ? 4 : 10;
      ctx.globalAlpha = i % 5 ? 0.35 : 0.9;
      ctx.lineWidth = i % 5 ? 1 : 2.5;
      ctx.beginPath();
      ctx.moveTo(Math.sin(a) * (84 - len), -Math.cos(a) * (84 - len));
      ctx.lineTo(Math.sin(a) * 84, -Math.cos(a) * 84);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const s = now.getSeconds() + now.getMilliseconds() / 1000;
    const m = now.getMinutes() + s / 60;
    const hr = (now.getHours() % 12) + m / 60;
    const hand = (angle, len, width, color) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-Math.sin(angle) * 10, Math.cos(angle) * 10);
      ctx.lineTo(Math.sin(angle) * len, -Math.cos(angle) * len);
      ctx.stroke();
    };
    hand((hr / 12) * Math.PI * 2, 45, 5, text);
    hand((m / 60) * Math.PI * 2, 66, 3.5, text);
    hand((s / 60) * Math.PI * 2, 74, 1.5, acc);
    ctx.fillStyle = acc;
    ctx.beginPath();
    ctx.arc(0, 0, 4, 0, Math.PI * 2);
    ctx.fill();
  };
  draw();
  const timer = setInterval(draw, 250);
  return () => clearInterval(timer);
}

// ─── Performance ──────────────────────────────────────────────────────────
function perfWidget(root) {
  const row = (label) => {
    const fill = h('i');
    const val = h('b', '–');
    root.append(h('div.w-perf-row', h('span', label), h('div.w-bar', fill), val));
    return { fill, val };
  };
  const cpu = row('CPU');
  const ram = row('RAM');
  const gpu = row('GPU');
  const net = h('div', { style: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)', display: 'flex', justifyContent: 'space-between' } });
  const canvas = h('canvas.w-spark');
  root.append(canvas, net);
  const history = Array(60).fill(0);

  const off = bus.on('server:metrics', (m) => {
    const ramPct = (m.ram_used_mb / m.ram_total_mb) * 100;
    cpu.fill.style.width = `${m.cpu}%`;
    cpu.val.textContent = `${m.cpu.toFixed(0)}%`;
    ram.fill.style.width = `${ramPct}%`;
    ram.val.textContent = `${(m.ram_used_mb / 1024).toFixed(1)}G`;
    gpu.fill.style.width = `${m.gpu}%`;
    gpu.val.textContent = `${m.gpu.toFixed(0)}%`;
    net.textContent = '';
    net.append(h('span', `↓ ${(m.net_down_kbps / 1024).toFixed(2)} MB/s`), h('span', `↑ ${(m.net_up_kbps / 1024).toFixed(2)} MB/s`), h('span', `${m.temp_c.toFixed(0)}°C`));
    history.push(m.cpu);
    history.shift();
    sparkline(canvas, history);
  });
  return off;
}

export function sparkline(canvas, data, max = 100) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || 240;
  const hgt = canvas.clientHeight || 56;
  if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = hgt * dpr; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hgt);
  const acc = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  const step = w / (data.length - 1);
  ctx.beginPath();
  data.forEach((v, i) => {
    const x = i * step;
    const y = hgt - (v / max) * (hgt - 4) - 2;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.strokeStyle = acc;
  ctx.lineWidth = 1.8;
  ctx.stroke();
  ctx.lineTo(w, hgt);
  ctx.lineTo(0, hgt);
  const g = ctx.createLinearGradient(0, 0, 0, hgt);
  g.addColorStop(0, `${acc}66`);
  g.addColorStop(1, `${acc}00`);
  ctx.fillStyle = g;
  ctx.fill();
}

// ─── Weather ──────────────────────────────────────────────────────────────
export const weatherIcon = (i) => ({ sun: icons.sun, 'cloud-sun': icons.cloudSun, cloud: icons.cloudPlain, rain: icons.rain, storm: icons.storm })[i] || icons.cloudSun;

function weatherWidget(root) {
  const load = async () => {
    let w;
    try {
      w = await api.get('/weather');
    } catch {
      w = { city: 'Offline', temp: 21, feels_like: 20, humidity: 50, wind_kph: 8, label: 'Partly cloudy', icon: 'cloud-sun', forecast: [] };
    }
    root.replaceChildren(
      h('div.w-weather-now',
        h('span', { html: weatherIcon(w.icon) }),
        h('div', h('div.w-weather-temp', `${w.temp}°`), h('div.w-weather-meta', w.label)),
      ),
      h('div.w-weather-meta', { style: { marginTop: '8px' } }, `${w.city} · Feels ${w.feels_like}° · 💧${w.humidity}% · 🌬 ${w.wind_kph} km/h`),
      h('div.w-forecast', w.forecast.map((d) => h('div', h('div', d.day), h('span', { html: weatherIcon(d.icon) }), h('b', `${d.hi}°`), ` ${d.lo}°`))),
    );
  };
  load();
  const timer = setInterval(load, 10 * 60 * 1000);
  return () => clearInterval(timer);
}

// ─── Notes ────────────────────────────────────────────────────────────────
function notesWidget(root, id) {
  const ta = h('textarea', { placeholder: 'Jot something down…', spellcheck: false });
  ta.value = store.get(`widgets.${id}.text`) || '';
  const saveText = debounce(() => store.set(`widgets.${id}.text`, ta.value), 500);
  ta.addEventListener('input', saveText);
  root.classList.add('w-notes');
  root.append(ta);
}
