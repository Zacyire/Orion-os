// SVG icon set. All icons are 24×24, stroke-based, and inherit currentColor.

const s = (body, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra}>${body}</svg>`;
const f = (body) => `<svg viewBox="0 0 24 24" fill="currentColor">${body}</svg>`;

export const icons = {
  // ── brand ──
  logo: `<svg viewBox="0 0 24 24"><defs><linearGradient id="lg-logo" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--accent-color)"/><stop offset="1" stop-color="var(--accent-color-2)"/></linearGradient></defs><rect x="2" y="2" width="9.3" height="9.3" rx="2" fill="url(#lg-logo)"/><rect x="12.7" y="2" width="9.3" height="9.3" rx="2" fill="url(#lg-logo)" opacity=".85"/><rect x="2" y="12.7" width="9.3" height="9.3" rx="2" fill="url(#lg-logo)" opacity=".7"/><rect x="12.7" y="12.7" width="9.3" height="9.3" rx="2" fill="url(#lg-logo)" opacity=".55"/></svg>`,

  // ── app glyphs ──
  folder: s('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  store: s('<path d="M4 8h16l-1 12H5z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>'),
  settings: s('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  notepad: s('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>'),

  globe: s('<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>'),
  play2: s('<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 9l5 3-5 3z" fill="currentColor"/>'),
  gamepad2: s('<path d="M6 11h4M8 9v4M15 12h.01M18 10h.01"/><path d="M17.3 5H6.7a4 4 0 0 0-4 3.6L2 15.4A2.6 2.6 0 0 0 4.6 18c.8 0 1.5-.4 2-1l1.6-2h7.6l1.6 2c.5.6 1.2 1 2 1a2.6 2.6 0 0 0 2.6-2.6l-.7-6.8a4 4 0 0 0-4-3.6z"/>'),
  music: s('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
  heart: s('<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>'),
  home: s('<path d="M3 10.5L12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>'),
  library: s('<path d="M4 4v16M9 4v16M14 4l6 16"/>'),
  external: s('<path d="M15 3h6v6M10 14L21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
  shield: s('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
  tab: s('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>'),
  star2: s('<path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/>'),

  // ── UI ──
  search: s('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>'),
  widgets: s('<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="5" rx="2"/><rect x="13" y="10" width="8" height="11" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/>'),
  wifi: s('<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0"/><circle cx="12" cy="19.5" r=".8" fill="currentColor"/>'),
  wifiOff: s('<path d="M2 2l20 20M8.5 16a5 5 0 0 1 7 0M5 12.5a10 10 0 0 1 5-2.7M16.7 10.7A10 10 0 0 1 19 12.5M2 9a15 15 0 0 1 4.2-2.8M10.7 5.1A15 15 0 0 1 22 9"/>'),
  volume: s('<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>'),
  volumeLow: s('<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>'),
  mute: s('<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M22 9l-6 6M16 9l6 6"/>'),
  battery: s('<rect x="2" y="7" width="18" height="10" rx="2"/><path d="M22 11v2"/><rect x="4" y="9" width="11" height="6" rx="1" fill="currentColor" stroke="none"/>'),
  bluetooth: s('<path d="M7 7l10 10-5 5V2l5 5L7 17"/>'),
  plane: s('<path d="M17.8 19.2L16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>'),
  moon: s('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
  sun: s('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  cloudSun: s('<path d="M12 2v2M4.9 4.9l1.4 1.4M20 12h2M19.1 4.9l-1.4 1.4"/><path d="M15.9 13A4 4 0 0 0 8.5 9.5"/><path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6z"/>'),
  cloudPlain: s('<path d="M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 1 1 0 9z"/>'),
  rain: s('<path d="M20 16.6A5 5 0 0 0 18 7h-1.3A8 8 0 1 0 4 15.3"/><path d="M8 19v2M8 13v2M16 19v2M16 13v2M12 21v2M12 15v2"/>'),
  storm: s('<path d="M19 16.9A5 5 0 0 0 18 7h-1.3A8 8 0 1 0 4 15.3"/><path d="M13 11l-4 6h6l-4 6"/>'),
  eco: s('<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10z"/><path d="M2 21c0-3 1.9-5.4 5.1-6"/>'),
  focus: s('<circle cx="12" cy="12" r="3"/><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/>'),
  close: s('<path d="M5 5l14 14M19 5L5 19"/>'),
  minimize: s('<path d="M4 12h16"/>'),
  maximize: s('<rect x="4" y="4" width="16" height="16" rx="1.5"/>'),
  restore: s('<rect x="4" y="8" width="12" height="12" rx="1.5"/><path d="M8 8V5.5A1.5 1.5 0 0 1 9.5 4h9A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H16"/>'),
  power: s('<path d="M18.4 6.6a9 9 0 1 1-12.8 0M12 2v10"/>'),
  restart: s('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
  lock: s('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  play: f('<path d="M7 4.5v15a1 1 0 0 0 1.5.9l12-7.5a1 1 0 0 0 0-1.8l-12-7.5A1 1 0 0 0 7 4.5z"/>'),
  pause: f('<rect x="6" y="4" width="4.5" height="16" rx="1.2"/><rect x="13.5" y="4" width="4.5" height="16" rx="1.2"/>'),
  next: f('<path d="M5 5.5v13a1 1 0 0 0 1.5.8l9.5-6.5a1 1 0 0 0 0-1.6L6.5 4.7A1 1 0 0 0 5 5.5z"/><rect x="17" y="4" width="2.5" height="16" rx="1"/>'),
  prev: f('<path d="M19 5.5v13a1 1 0 0 1-1.5.8L8 12.8a1 1 0 0 1 0-1.6l9.5-6.5A1 1 0 0 1 19 5.5z"/><rect x="4.5" y="4" width="2.5" height="16" rx="1"/>'),
  shuffle: s('<path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>'),
  repeat: s('<path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>'),
  fullscreen: s('<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>'),
  pip: s('<rect x="2" y="4" width="20" height="16" rx="2"/><rect x="12" y="12" width="7" height="5" rx="1" fill="currentColor"/>'),
  list: s('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'),
  plus: s('<path d="M12 5v14M5 12h14"/>'),
  trash: s('<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'),
  download: s('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>'),
  upload: s('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>'),
  save: s('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>'),
  open: s('<path d="M6 14l1.5-2.9A2 2 0 0 1 9.2 10H20a2 2 0 0 1 1.9 2.5l-1.5 6A2 2 0 0 1 18.4 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.7.9l.8 1.2a2 2 0 0 0 1.7.9H18a2 2 0 0 1 2 2v2"/>'),
  file: s('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>'),
  eye: s('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>'),
  refresh: s('<path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/>'),
  pin: s('<path d="M12 17v5M9 10.8V4h6v6.8l3 3.2v2H6v-2z"/>'),
  unpin: s('<path d="M2 2l20 20M12 17v5M9 9v1.8L6 14v2h10M15 9.3V4H9"/>'),
  desktop: s('<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>'),
  sort: s('<path d="M3 6h18M6 12h12M10 18h4"/>'),
  palette: s('<circle cx="13.5" cy="6.5" r="1" fill="currentColor"/><circle cx="17.5" cy="10.5" r="1" fill="currentColor"/><circle cx="8.5" cy="7.5" r="1" fill="currentColor"/><circle cx="6.5" cy="12.5" r="1" fill="currentColor"/><path d="M12 2a10 10 0 0 0 0 20c1 0 1.7-.8 1.7-1.7 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.8-1.7 1.7-1.7h2A5.6 5.6 0 0 0 22 11c0-5-4.5-9-10-9z"/>'),
  taskbar: s('<rect x="2" y="3" width="20" height="18" rx="2"/><path d="M2 16h20M7 18.5h.01M10 18.5h.01"/>'),
  arrowUp: s('<path d="M12 19V5M5 12l7-7 7 7"/>'),
  arrowDown: s('<path d="M12 5v14M19 12l-7 7-7-7"/>'),
  arrowLeft: s('<path d="M19 12H5M12 19l-7-7 7-7"/>'),
  arrowRight: s('<path d="M5 12h14M12 5l7 7-7 7"/>'),
  chevronRight: s('<path d="M9 18l6-6-6-6"/>'),
  chevronLeft: s('<path d="M15 18l-6-6 6-6"/>'),
  chevronDown: s('<path d="M6 9l6 6 6-6"/>'),
  check: s('<path d="M20 6L9 17l-5-5"/>'),
  info: s('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>'),
  star: f('<path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/>'),
  signal: s('<path d="M2 20h.01M7 20v-4M12 20v-8M17 20V8M22 4v16"/>'),
  user: s('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  drive: s('<path d="M22 12H2M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z"/><path d="M6 16h.01M10 16h.01"/>'),
  grid: s('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'),
  sparkles: s('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8zM5 2l.6 1.4L7 4l-1.4.6L5 6l-.6-1.4L3 4l1.4-.6z"/>'),
  bolt: s('<path d="M13 2L3 14h9l-1 8 10-12h-9z"/>'),
  cpu: s('<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>'),
  note: s('<path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5z"/><path d="M15 3v6h6"/>'),
  clock: s('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'),
  code: s('<path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/>'),
  edit: s('<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  brush: s('<path d="M9.06 11.9l8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08"/><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z"/>'),
  eraser: s('<path d="M7 21l-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21M22 21H7M5 11l9 9"/>'),
  undo: s('<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>'),
  gamepad: s('<rect x="2" y="6" width="20" height="12" rx="6"/><path d="M6 12h4M8 10v4M15 13h.01M18 11h.01"/>'),
  trophy: s('<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.7V17c0 .6-.5 1-1 1.2C7.8 18.8 7 20.2 7 22M14 14.7V17c0 .6.5 1 1 1.2 1.2.6 2 2 2 3.8M18 2H6v7a6 6 0 0 0 12 0z"/>'),
};

/**
 * Full-tile artwork for first-party apps (64×64). `__ID__` is replaced with a
 * per-instance suffix so gradient/filter references never collide.
 */
export const tileArt = {
  netflix: `<svg viewBox="0 0 64 64"><defs>
    <linearGradient id="nf-a__ID__" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b20710"/><stop offset="1" stop-color="#7a040a"/></linearGradient>
    <linearGradient id="nf-b__ID__" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff1a24"/><stop offset="1" stop-color="#d10812"/></linearGradient>
    <filter id="nf-s__ID__" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="0" stdDeviation="1.6" flood-color="#000" flood-opacity=".7"/></filter></defs>
    <rect width="64" height="64" rx="14" fill="#0b0b0b"/>
    <path d="M21 11h8.5v42.5L21 51z" fill="url(#nf-a__ID__)"/>
    <path d="M34.5 11H43v40l-8.5 2.5z" fill="url(#nf-a__ID__)"/>
    <path d="M21 11h8.5L43 51l-8.5 2.5z" fill="url(#nf-b__ID__)" filter="url(#nf-s__ID__)"/></svg>`,

  spiceify: `<svg viewBox="0 0 64 64"><defs>
    <radialGradient id="sp-g__ID__" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#2cf07a"/><stop offset="1" stop-color="#17b350"/></radialGradient></defs>
    <rect width="64" height="64" rx="14" fill="#121212"/>
    <circle cx="32" cy="32" r="23" fill="url(#sp-g__ID__)"/>
    <g fill="#0b0b0b"><rect x="19" y="28" width="4" height="8" rx="2"/><rect x="25" y="22" width="4" height="20" rx="2"/><rect x="31" y="17" width="4" height="30" rx="2"/><rect x="37" y="23" width="4" height="18" rx="2"/><rect x="43" y="28.5" width="4" height="7" rx="2"/></g></svg>`,

  geforcenow: `<svg viewBox="0 0 64 64"><defs>
    <radialGradient id="gf-bg__ID__" cx="50%" cy="45%" r="70%"><stop offset="0" stop-color="#1a2410"/><stop offset="1" stop-color="#070906"/></radialGradient>
    <linearGradient id="gf-g__ID__" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#b6ff3b"/><stop offset="1" stop-color="#5a9a00"/></linearGradient>
    <filter id="gf-glow__ID__" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
    <rect width="64" height="64" rx="14" fill="url(#gf-bg__ID__)"/>
    <g filter="url(#gf-glow__ID__)">
      <path d="M32 9l19.5 11.25v23.5L32 55 12.5 43.75v-23.5z" fill="none" stroke="url(#gf-g__ID__)" stroke-width="3" stroke-linejoin="round"/>
      <g fill="url(#gf-g__ID__)">
        <path id="gf-blade__ID__" d="M32 32c-1-6 2.5-11.5 9-13.2-3.8 2.8-5.6 6.7-5.3 11.5z"/>
        <use href="#gf-blade__ID__" transform="rotate(120 32 32)"/>
        <use href="#gf-blade__ID__" transform="rotate(240 32 32)"/>
      </g>
      <circle cx="32" cy="32" r="3" fill="#d9ff9e"/>
    </g></svg>`,

  vapor: `<svg viewBox="0 0 64 64"><defs>
    <filter id="vp-brush__ID__" x="-20%" y="-20%" width="140%" height="140%">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="4" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="2.6" xChannelSelector="R" yChannelSelector="G" result="d"/>
      <feComposite in="d" in2="n" operator="out" result="gaps"/>
      <feMerge><feMergeNode in="d"/></feMerge></filter></defs>
    <rect width="64" height="64" rx="14" fill="#0a0a0a"/>
    <g fill="none" stroke="#f4f4f4" stroke-linecap="round" stroke-width="5.5" filter="url(#vp-brush__ID__)">
      <path d="M20 52c-5-7 5-11 0-18s5-11 1-19"/>
      <path d="M32 54c-5-8 6-12 0-20s5-12 1-22"/>
      <path d="M44 52c-5-7 5-11 0-18s5-11 1-19"/>
    </g></svg>`,

  youtube: `<svg viewBox="0 0 64 64">
    <rect width="64" height="64" rx="14" fill="#0f0f0f"/>
    <rect x="8" y="15" width="48" height="34" rx="10" fill="#ff0000"/>
    <path d="M27 24.5v15l13-7.5z" fill="#fff"/></svg>`,

  orion: `<svg viewBox="0 0 64 64"><defs>
    <radialGradient id="or-bg__ID__" cx="50%" cy="40%" r="75%"><stop offset="0" stop-color="#0f2356"/><stop offset="1" stop-color="#050a1c"/></radialGradient>
    <radialGradient id="or-g__ID__" cx="38%" cy="32%" r="75%"><stop offset="0" stop-color="#8fe3ff"/><stop offset=".45" stop-color="#2f8cff"/><stop offset="1" stop-color="#1231a8"/></radialGradient>
    <filter id="or-glow__ID__" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="3"/></filter></defs>
    <rect width="64" height="64" rx="14" fill="url(#or-bg__ID__)"/>
    <circle cx="32" cy="32" r="18" fill="#2f8cff" opacity=".55" filter="url(#or-glow__ID__)"/>
    <circle cx="32" cy="32" r="16" fill="url(#or-g__ID__)"/>
    <g fill="none" stroke="#bfefff" stroke-opacity=".55" stroke-width="1.2">
      <ellipse cx="32" cy="32" rx="7" ry="16"/><path d="M16 32h32M18.5 24h27M18.5 40h27"/></g>
    <ellipse cx="32" cy="32" rx="26" ry="8" fill="none" stroke="#9fdcff" stroke-width="1.6" transform="rotate(-22 32 32)" opacity=".9"/>
    <circle cx="54" cy="23" r="2.2" fill="#fff"/><circle cx="12" cy="14" r="1" fill="#fff" opacity=".8"/><circle cx="50" cy="52" r=".9" fill="#fff" opacity=".7"/></svg>`,
};

let artSeq = 0;

/**
 * Colour pairs for app tiles so each app gets a distinctive gradient.
 */
export const tileColors = {
  appstore: ['#2f7bff', '#00c6ff'],
  settings: ['#5f6b80', '#343c4b'],
  notepad: ['#2fbf8f', '#1a8a78'],
};

/** Build an app tile element (`<div class="app-icon">`). */
export function appIcon(app, size = '') {
  const el = document.createElement('div');
  el.className = `app-icon ${size}`.trim();
  const art = tileArt[app.icon];
  if (art) {
    el.classList.add('art');
    el.innerHTML = art.replaceAll('__ID__', `-${++artSeq}`);
    return el;
  }
  // User-supplied icon URL (web-app installer). Falls back to a glyph on error.
  if (app.iconUrl) {
    el.classList.add('art');
    const img = document.createElement('img');
    img.src = app.iconUrl;
    img.alt = '';
    img.loading = 'lazy';
    img.onerror = () => { el.classList.remove('art'); el.innerHTML = icons.globe; };
    el.appendChild(img);
    return el;
  }
  const [a, b] = app.color ? [app.color, shade(app.color)] : tileColors[app.id] || ['#3b4252', '#232834'];
  el.style.setProperty('--tile-a', a);
  el.style.setProperty('--tile-b', b);
  el.innerHTML = icons[app.icon === 'web' ? 'globe' : app.icon] || icons.grid;
  return el;
}

/** Darken a #rrggbb colour for the second gradient stop. */
function shade(hex) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.round(v * 0.55).toString(16).padStart(2, '0');
  return `#${f((n >> 16) & 255)}${f((n >> 8) & 255)}${f(n & 255)}`;
}

export const icon = (name) => icons[name] || '';
