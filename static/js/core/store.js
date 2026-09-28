// Preferences store. Source of truth lives on the Rust backend (`/api/prefs`);
// a copy is mirrored to localStorage so the desktop survives offline boots.
//
//   store.get('taskbar.position')          → 'bottom'
//   store.set('taskbar.position', 'left')  → emits 'prefs:taskbar' + debounced PATCH
//   store.watch('taskbar', fn)             → fn(section) on change

import { api } from './api.js';
import { bus } from './events.js';
import { local } from './dom.js';

// Mirrors default_prefs() in src/state.rs (used when the API is unreachable).
const FALLBACK = {
  user: { name: 'User' },
  theme: { mode: 'dark', accent: '#4c8dff', transparency: true, glassOpacity: 0.62, wallpaper: 'default', animateWallpaper: true },
  taskbar: { position: 'bottom', pinned: ['orion', 'netflix', 'spiceify', 'youtube', 'vapor', 'geforcenow', 'appstore'], autoHide: false, centered: true },
  desktop: { shortcuts: [
    { app: 'orion', col: 0, row: 0 }, { app: 'netflix', col: 0, row: 1 }, { app: 'spiceify', col: 0, row: 2 },
    { app: 'youtube', col: 0, row: 3 }, { app: 'vapor', col: 0, row: 4 }, { app: 'geforcenow', col: 0, row: 5 },
    { app: 'appstore', col: 1, row: 0 }, { app: 'notepad', col: 1, row: 1 }, { app: 'settings', col: 1, row: 2 },
  ] },
  boot: { skipAnimation: false },
};

let prefs = structuredClone(FALLBACK);

// Renamed app ids (mirrors RENAMED_APPS in src/state.rs) for locally cached prefs.
const RENAMED = { notnetflix: 'netflix' };
function migrateIds(p) {
  if (Array.isArray(p.taskbar?.pinned)) p.taskbar.pinned = p.taskbar.pinned.map((id) => RENAMED[id] || id);
  for (const s of p.desktop?.shortcuts || []) s.app = RENAMED[s.app] || s.app;
}
const dirty = new Set();
let flushTimer;

function deepMerge(base, over) {
  if (Array.isArray(over) || typeof over !== 'object' || over === null) return over;
  const out = { ...(typeof base === 'object' && base && !Array.isArray(base) ? base : {}) };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(out[k], v);
  return out;
}

export const store = {
  async load({ timeout } = {}) {
    const cached = local.get('prefs');
    try {
      prefs = deepMerge(FALLBACK, await api.get('/prefs', { timeout }));
    } catch {
      prefs = deepMerge(FALLBACK, cached || {});
    }
    migrateIds(prefs);
    local.set('prefs', prefs);
    return prefs;
  },

  get(path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), prefs);
  },

  set(path, value) {
    const keys = path.split('.');
    let o = prefs;
    for (const k of keys.slice(0, -1)) o = o[k] ??= {};
    o[keys.at(-1)] = value;
    const section = keys[0];
    dirty.add(section);
    local.set('prefs', prefs);
    bus.emit(`prefs:${section}`, prefs[section]);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => store.flush(), 400);
  },

  /** Mutate a section in place via callback, then persist. */
  update(section, fn) {
    fn(prefs[section]);
    store.set(section, prefs[section]);
  },

  watch(section, fn) {
    return bus.on(`prefs:${section}`, fn);
  },

  async flush() {
    if (!dirty.size) return;
    const patch = {};
    for (const s of dirty) patch[s] = prefs[s];
    dirty.clear();
    try {
      await api.patch('/prefs', patch);
    } catch { /* offline — localStorage copy remains */ }
  },

  async reset() {
    try {
      prefs = deepMerge(FALLBACK, await api.post('/prefs/reset'));
    } catch {
      prefs = structuredClone(FALLBACK);
    }
    local.set('prefs', prefs);
    for (const s of Object.keys(prefs)) bus.emit(`prefs:${s}`, prefs[s]);
  },
};

// Arrays must be replaced wholesale, which merge-patch does — but we send
// whole sections anyway so server and client never diverge.
window.addEventListener('beforeunload', () => store.flush());
