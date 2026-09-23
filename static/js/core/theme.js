// Applies theme prefs to CSS custom properties.
import { store } from './store.js';

export const ACCENTS = ['#4c8dff', '#0078d4', '#7c5cff', '#8e8cd8', '#00b294', '#1db954', '#76b900', '#ffb900', '#ff8c00', '#e50914'];

function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let hh = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    hh = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    hh *= 60;
  }
  return [hh, s * 100, l * 100];
}

function hslToHex(hh, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + hh / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return `#${[f(0), f(8), f(4)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

export function applyTheme(theme = store.get('theme')) {
  const root = document.documentElement;
  const accent = /^#[0-9a-f]{6}$/i.test(theme.accent) ? theme.accent : '#4c8dff';
  const [hh, s, l] = hexToHsl(accent);
  root.style.setProperty('--accent-color', accent);
  // Secondary accent: hue-shifted partner colour for gradients.
  root.style.setProperty('--accent-color-2', hslToHex((hh + 55) % 360, Math.min(100, s + 10), Math.min(70, l + 8)));
  root.style.setProperty('--accent-color-contrast', l > 62 ? '#111' : '#fff');
  root.dataset.theme = theme.mode === 'light' ? 'light' : 'dark';
  root.dataset.transparency = theme.transparency === false ? 'off' : 'on';
  // Inline value beats the [data-transparency] rule, so honour "off" here too.
  const glass = Number.isFinite(Number(theme.glassOpacity)) ? Math.min(1, Math.max(0.2, Number(theme.glassOpacity))) : 0.62;
  root.style.setProperty('--system-glass-opacity', theme.transparency === false ? 1 : glass);
}

export function initTheme() {
  applyTheme();
  store.watch('theme', applyTheme);
}
