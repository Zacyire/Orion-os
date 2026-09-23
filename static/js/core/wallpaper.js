// Live wallpaper engine (HTML5 Canvas).
//   particles — interactive particle network that reacts to the cursor
//   aurora    — slow drifting gradient blobs (mesh-gradient look)
//   synthwave — retro sun + perspective grid
// Animation can be paused from Settings / quick settings to save power.

import { $ } from './dom.js';
import { store } from './store.js';

let canvas, ctx, raf = 0, W = 0, H = 0, dpr = 1, t = 0;
let mode = 'particles';
let animate = true;
let accent = '#7c5cff';
let accent2 = '#00d4ff';
const mouse = { x: -9999, y: -9999 };
let particles = [];

export const MODES = [
  { id: 'particles', name: 'Particle network' },
  { id: 'aurora', name: 'Aurora gradient' },
  { id: 'synthwave', name: 'Synthwave grid' },
];

export const wallpaper = {
  init() {
    canvas = $('#wallpaper');
    ctx = canvas.getContext('2d');
    this.apply(store.get('theme'));
    store.watch('theme', (th) => this.apply(th));
    window.addEventListener('resize', resize);
    window.addEventListener('pointermove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
    resize();
  },

  apply(theme) {
    const cs = getComputedStyle(document.documentElement);
    accent = theme.accent || cs.getPropertyValue('--accent').trim();
    accent2 = cs.getPropertyValue('--accent-2').trim() || '#00d4ff';
    const nextMode = theme.wallpaper || 'particles';
    if (nextMode !== mode) {
      mode = nextMode;
      seed();
    }
    animate = theme.animateWallpaper !== false;
    stop();
    animate ? start() : frame();
  },
};

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = innerWidth;
  H = innerHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  seed();
  if (!animate) frame();
}

function seed() {
  const count = Math.min(140, Math.floor((W * H) / 14000));
  particles = Array.from({ length: count }, () => ({
    x: Math.random() * W,
    y: Math.random() * H,
    vx: (Math.random() - 0.5) * 0.35,
    vy: (Math.random() - 0.5) * 0.35,
    r: Math.random() * 1.8 + 0.6,
  }));
}

function start() {
  if (!animate || raf || document.hidden) return;
  const loop = () => {
    t += 1;
    frame();
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
}

function stop() {
  cancelAnimationFrame(raf);
  raf = 0;
}

function frame() {
  if (mode === 'aurora') aurora();
  else if (mode === 'synthwave') synthwave();
  else network();
}

function background() {
  const light = document.documentElement.dataset.theme === 'light';
  const g = ctx.createLinearGradient(0, 0, W, H);
  if (light) {
    g.addColorStop(0, '#dfe7ff');
    g.addColorStop(1, '#f5e9ff');
  } else {
    g.addColorStop(0, '#070812');
    g.addColorStop(0.5, '#0d0f22');
    g.addColorStop(1, '#130a1f');
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  return light;
}

function glow(x, y, r, color, alpha) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, hexA(color, alpha));
  g.addColorStop(1, hexA(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

function network() {
  const light = background();
  glow(W * 0.2, H * 0.3, Math.max(W, H) * 0.5, accent, light ? 0.25 : 0.22);
  glow(W * 0.85, H * 0.75, Math.max(W, H) * 0.45, accent2, light ? 0.2 : 0.14);

  const LINK = 130;
  for (const p of particles) {
    if (animate) {
      p.x += p.vx;
      p.y += p.vy;
      // cursor gently attracts nearby nodes
      const dx = mouse.x - p.x;
      const dy = mouse.y - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < 180 * 180) {
        p.x += dx * 0.004;
        p.y += dy * 0.004;
      }
      if (p.x < 0 || p.x > W) p.vx *= -1;
      if (p.y < 0 || p.y > H) p.vy *= -1;
    }
  }
  ctx.lineWidth = 1;
  for (let i = 0; i < particles.length; i++) {
    const a = particles[i];
    for (let j = i + 1; j < particles.length; j++) {
      const b = particles[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d = dx * dx + dy * dy;
      if (d < LINK * LINK) {
        ctx.strokeStyle = hexA(accent, (1 - Math.sqrt(d) / LINK) * 0.35);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
    const md = Math.hypot(mouse.x - a.x, mouse.y - a.y);
    if (md < 180) {
      ctx.strokeStyle = hexA(accent2, (1 - md / 180) * 0.5);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(mouse.x, mouse.y);
      ctx.stroke();
    }
  }
  for (const p of particles) {
    ctx.fillStyle = light ? hexA(accent, 0.8) : 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function aurora() {
  const light = background();
  const s = t * 0.004;
  const R = Math.max(W, H);
  const blobs = [
    [0.3 + Math.sin(s) * 0.2, 0.35 + Math.cos(s * 1.3) * 0.2, 0.55, accent, 0.45],
    [0.75 + Math.cos(s * 0.8) * 0.18, 0.3 + Math.sin(s * 1.1) * 0.2, 0.5, accent2, 0.35],
    [0.5 + Math.sin(s * 0.6 + 2) * 0.25, 0.8 + Math.cos(s * 0.9) * 0.12, 0.6, '#ff3cac', 0.3],
    [0.15 + Math.cos(s * 1.2 + 1) * 0.1, 0.85 + Math.sin(s) * 0.1, 0.4, '#2b86c5', 0.35],
  ];
  ctx.globalCompositeOperation = light ? 'multiply' : 'lighter';
  for (const [x, y, r, c, a] of blobs) glow(W * x, H * y, R * r, c, light ? a * 0.6 : a);
  ctx.globalCompositeOperation = 'source-over';
  // subtle grain
  ctx.fillStyle = light ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.15)';
  ctx.fillRect(0, 0, W, H);
}

function synthwave() {
  ctx.fillStyle = '#0a0014';
  ctx.fillRect(0, 0, W, H);
  const horizon = H * 0.58;
  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, '#0a0014');
  sky.addColorStop(1, '#3b0a45');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, horizon);

  // stars
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  for (let i = 0; i < 80; i++) {
    const x = (i * 9301 + 49297) % 233280 / 233280 * W;
    const y = (i * 4096 + 150889) % 714025 / 714025 * horizon * 0.8;
    const tw = 0.5 + 0.5 * Math.sin(t * 0.03 + i);
    ctx.globalAlpha = tw;
    ctx.fillRect(x, y, 1.5, 1.5);
  }
  ctx.globalAlpha = 1;

  // sun with scanline cut-outs
  const sunR = Math.min(W, H) * 0.2;
  const sx = W / 2;
  const sy = horizon - sunR * 0.35;
  const sun = ctx.createLinearGradient(0, sy - sunR, 0, sy + sunR);
  sun.addColorStop(0, '#ffd319');
  sun.addColorStop(0.5, '#ff2975');
  sun.addColorStop(1, accent);
  ctx.save();
  ctx.beginPath();
  ctx.arc(sx, sy, sunR, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = sun;
  ctx.fillRect(sx - sunR, sy - sunR, sunR * 2, sunR * 2);
  ctx.fillStyle = '#3b0a45';
  for (let i = 0; i < 8; i++) {
    const y = sy + sunR * 0.1 + i * sunR * 0.12;
    ctx.fillRect(sx - sunR, y, sunR * 2, 2 + i * 1.3);
  }
  ctx.restore();
  glow(sx, sy, sunR * 2.4, '#ff2975', 0.25);

  // ground + perspective grid
  ctx.fillStyle = '#120018';
  ctx.fillRect(0, horizon, W, H - horizon);
  ctx.strokeStyle = hexA(accent2, 0.7);
  ctx.lineWidth = 1.2;
  const off = (t * 1.2) % 40;
  for (let i = 0; i < 24; i++) {
    const z = i * 40 + (40 - off);
    const y = horizon + (H - horizon) * (z / 960) ** 2.2;
    ctx.globalAlpha = Math.min(1, z / 300);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  for (let i = -20; i <= 20; i++) {
    ctx.beginPath();
    ctx.moveTo(sx + i * 12, horizon);
    ctx.lineTo(sx + i * W * 0.12, H);
    ctx.stroke();
  }
}

function hexA(hex, a) {
  const m = hex.replace('#', '').match(/^([0-9a-f]{6}|[0-9a-f]{3})$/i);
  if (!m) return `rgba(124,92,255,${a})`;
  let s = m[1];
  if (s.length === 3) s = [...s].map((c) => c + c).join('');
  const n = parseInt(s, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
