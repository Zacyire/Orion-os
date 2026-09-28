// Live wallpaper engine.
//
// Wallpapers come from GET /api/content/wallpapers (content/wallpapers.json +
// any video dropped into static/media/wallpapers/). Each is mounted as a layer
// inside #wallpaper and crossfaded in once it can play:
//   video → <video autoplay loop muted playsinline>   (primary)
//   image → <img>
//   procedural → <canvas> gradient (built-in fallback, no media required)
// Playback pauses when animation is disabled, the tab is hidden, a maximized
// window covers the desktop, or the user prefers reduced motion.

import { $, h } from './dom.js';
import { api } from './api.js';
import { store } from './store.js';
import { bus } from './events.js';
import { wm } from './wm.js';

const PROCEDURAL = { id: 'procedural', name: 'Procedural gradient', type: 'procedural' };
const BUILTIN = { id: 'aurora-ridge', name: 'Aurora Ridge', type: 'video', src: 'media/wallpapers/aurora-ridge.webm', poster: 'media/wallpapers/aurora-ridge.jpg' };
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

let root;
let manifest = { default: BUILTIN.id, items: [BUILTIN] };
let active = null; // { item, el, stop? }
let animate = true;
let covered = false; // a maximized window hides the wallpaper completely

export const wallpaper = {
  async init({ timeout } = {}) {
    root = $('#wallpaper');
    const doc = await api.content('wallpapers', { timeout });
    if (doc.items?.length) manifest = doc;
    store.watch('theme', (th) => this.apply(th));
    document.addEventListener('visibilitychange', () => syncPlayback());
    reducedMotion.addEventListener?.('change', () => syncPlayback());
    // Don't decode video nobody can see: pause while a maximized window covers the desktop.
    bus.on('wm:changed', () => {
      const next = wm.list.some((w) => w.maximized && !w.minimized);
      if (next !== covered) { covered = next; syncPlayback(); }
    });
    this.apply(store.get('theme'));
  },

  /** All selectable wallpapers (manifest + procedural fallback). */
  list() {
    return [...manifest.items, PROCEDURAL];
  },

  current() {
    return active?.item;
  },

  apply(theme) {
    animate = theme.animateWallpaper !== false;
    const item = resolve(theme.wallpaper);
    if (active?.item.id !== item.id) mount(item);
    syncPlayback();
  },

  async refresh() {
    const doc = await api.content('wallpapers');
    if (doc.items?.length) manifest = doc;
    bus.emit('wallpaper:list', this.list());
    return this.list();
  },
};

function resolve(id) {
  const all = wallpaper.list();
  const want = !id || id === 'default' ? manifest.default : id;
  return all.find((w) => w.id === want) || manifest.items[0] || PROCEDURAL;
}

function mount(item) {
  const prev = active;
  let layer;
  if (item.type === 'video') {
    layer = h('video', {
      muted: true, loop: true, autoplay: true, playsInline: true, preload: 'auto',
      poster: item.poster || undefined, disablePictureInPicture: true,
    });
    layer.muted = true; // must be a property for autoplay policies
    layer.setAttribute('playsinline', '');
    layer.addEventListener('canplay', () => reveal(layer, prev), { once: true });
    layer.addEventListener('error', () => {
      console.warn(`[wallpaper] could not play ${item.src}; using fallback`);
      if (active?.el === layer) mount(item.poster ? { ...item, type: 'image', src: item.poster } : PROCEDURAL);
    }, { once: true });
    layer.src = item.src;
  } else if (item.type === 'image') {
    layer = h('img', { alt: '', decoding: 'async' });
    layer.addEventListener('load', () => reveal(layer, prev), { once: true });
    layer.addEventListener('error', () => { if (active?.el === layer) mount(PROCEDURAL); }, { once: true });
    layer.src = item.src;
  } else {
    layer = h('canvas');
    active = { item, el: layer, stop: procedural(layer) };
    root.append(layer);
    requestAnimationFrame(() => reveal(layer, prev));
    return;
  }
  active = { item, el: layer };
  root.append(layer);
}

function reveal(layer, prev) {
  layer.classList.add('wp-active');
  syncPlayback();
  if (prev && prev.el !== layer) {
    prev.el.classList.remove('wp-active');
    setTimeout(() => { prev.stop?.(); prev.el.remove(); }, 1300);
  }
}

function syncPlayback() {
  const el = active?.el;
  const run = animate && !covered && !document.hidden && !reducedMotion.matches;
  if (el instanceof HTMLVideoElement) {
    if (run) el.play().catch(() => { /* autoplay blocked until interaction */ });
    else el.pause();
  }
  active?.el.dispatchEvent(new CustomEvent('wp-run', { detail: run }));
}

// Autoplay can be blocked until the first user gesture on some browsers.
window.addEventListener('pointerdown', () => syncPlayback(), { once: true });

/** Slow drifting gradient mesh on a canvas; returns a stop function. */
function procedural(canvas) {
  const ctx = canvas.getContext('2d');
  let raf = 0;
  let t = 0;
  let running = true;
  const resize = () => {
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  };
  const accent = () => getComputedStyle(document.documentElement).getPropertyValue('--accent-color').trim() || '#4c8dff';
  const accent2 = () => getComputedStyle(document.documentElement).getPropertyValue('--accent-color-2').trim() || '#7c5cff';
  function blob(x, y, r, color, a) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color + Math.round(a * 255).toString(16).padStart(2, '0'));
    g.addColorStop(1, color + '00');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  function draw() {
    const W = innerWidth, H = innerHeight, R = Math.max(W, H), s = t * 0.0025;
    ctx.fillStyle = '#06070d';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    blob(W * (0.3 + Math.sin(s) * 0.15), H * (0.35 + Math.cos(s * 1.3) * 0.15), R * 0.55, accent(), 0.35);
    blob(W * (0.75 + Math.cos(s * 0.8) * 0.12), H * (0.3 + Math.sin(s * 1.1) * 0.15), R * 0.5, accent2(), 0.28);
    blob(W * (0.5 + Math.sin(s * 0.6 + 2) * 0.2), H * (0.85 + Math.cos(s * 0.9) * 0.08), R * 0.6, '#0f2a6b', 0.5);
    ctx.globalCompositeOperation = 'source-over';
  }
  const loop = () => { t++; draw(); raf = requestAnimationFrame(loop); };
  canvas.addEventListener('wp-run', (e) => {
    running = e.detail;
    cancelAnimationFrame(raf);
    if (running) raf = requestAnimationFrame(loop);
  });
  addEventListener('resize', resize);
  resize();
  return () => { cancelAnimationFrame(raf); removeEventListener('resize', resize); };
}
