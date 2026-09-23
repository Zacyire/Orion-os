// Window manager: creation, focus/z-order, drag, resize, snap,
// minimize/maximize/restore/close, and app mounting.

import { h, $, clamp } from './dom.js';
import { icons, appIcon } from './icons.js';
import { bus } from './events.js';
import { registry } from './registry.js';
import { api } from './api.js';
import { store } from './store.js';
import { notify } from './notify.js';
import { contextMenu } from './contextmenu.js';

const SNAP_EDGE = 10;
const MIN_W = 320;
const MIN_H = 200;

let seq = 0;
let zTop = 100;
let cascade = 0;

class WindowManager {
  windows = new Map();
  focusedId = null;
  layer = null;

  init() {
    this.layer = $('#windows');
    this.snapEl = $('#snap-preview');
    // Clicking the bare desktop removes focus from all windows.
    $('#desktop').addEventListener('pointerdown', () => this.focus(null));
    window.addEventListener('resize', () => this.#clampAll());
    bus.on('wm:close-app', (appId) => this.closeApp(appId));
  }

  get list() {
    return [...this.windows.values()];
  }

  byApp(appId) {
    return this.list.filter((w) => w.appId === appId);
  }

  /** Launch an app (or focus it when the module is single-instance). */
  async open(appId, args = {}) {
    const app = registry.get(appId);
    if (!app) return notify('App not found', `No app registered as "${appId}".`, { type: 'error' });
    if (!app.installed) {
      notify(`${app.name} isn't installed`, 'Get it from the App Store.', { type: 'error' });
      return this.open('appstore', { focus: appId });
    }

    let mod;
    try {
      mod = await registry.loadModule(appId);
    } catch (err) {
      console.error(err);
      return notify(`Couldn't start ${app.name}`, err.message, { type: 'error' });
    }

    if (mod.single) {
      const existing = this.byApp(appId)[0];
      if (existing) {
        if (existing.minimized) this.restore(existing.id);
        this.focus(existing.id);
        existing.instance?.onArgs?.(args);
        return existing;
      }
    }

    const win = this.#createWindow(app, mod);
    this.#mount(win, mod, args);
    return win;
  }

  #createWindow(app, mod) {
    const id = `w${++seq}`;
    const area = this.layer.getBoundingClientRect();
    const [dw, dh] = mod.size || app.default_size || [800, 520];
    const w = Math.min(dw, area.width - 20);
    const hgt = Math.min(dh, area.height - 20);
    const off = (cascade++ % 8) * 28;
    const x = clamp((area.width - w) / 2 + off - 84, 0, Math.max(0, area.width - w));
    const y = clamp((area.height - hgt) / 2 + off - 84, 0, Math.max(0, area.height - hgt));

    const titleEl = h('span.win-title', app.name);
    const maxBtn = h('button.win-max', { title: 'Maximize', 'aria-label': 'Maximize', html: icons.maximize });
    const titlebar = h('header.win-titlebar',
      appIcon(app, 'sm'),
      titleEl,
      h('div.win-controls',
        h('button.win-min', { title: 'Minimize', 'aria-label': 'Minimize', html: icons.minimize }),
        maxBtn,
        h('button.win-close', { title: 'Close', 'aria-label': 'Close', html: icons.close }),
      ),
    );
    const body = h('div.win-body.loading');
    const el = h('section.window', { role: 'dialog', 'aria-label': app.name, dataset: { id, app: app.id } },
      titlebar, body,
      ...['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((d) => h('div.win-resize', { dataset: { dir: d } })),
    );
    Object.assign(el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${hgt}px` });
    if (mod.theme) el.classList.add(`theme-${mod.theme}`);

    const win = {
      id, app, appId: app.id, el, body, titleEl, maxBtn,
      minimized: false, maximized: false, prev: null, instance: null, cleanup: null,
      title: app.name,
    };
    this.windows.set(id, win);
    this.layer.append(el);

    // controls
    titlebar.querySelector('.win-min').addEventListener('click', (e) => { e.stopPropagation(); this.minimize(id); });
    maxBtn.addEventListener('click', (e) => { e.stopPropagation(); this.toggleMaximize(id); });
    titlebar.querySelector('.win-close').addEventListener('click', (e) => { e.stopPropagation(); this.close(id); });
    titlebar.addEventListener('dblclick', (e) => { if (!e.target.closest('.win-controls')) this.toggleMaximize(id); });
    titlebar.addEventListener('pointerdown', (e) => this.#startDrag(e, win));
    titlebar.addEventListener('contextmenu', (e) => { e.preventDefault(); this.#titleMenu(e, win); });
    el.addEventListener('pointerdown', () => this.focus(id), true);
    for (const handle of el.querySelectorAll('.win-resize')) {
      handle.addEventListener('pointerdown', (e) => this.#startResize(e, win, handle.dataset.dir));
    }

    this.focus(id);
    bus.emit('wm:changed');
    return win;
  }

  #mount(win, mod, args) {
    const ctx = {
      win: {
        id: win.id,
        el: win.el,
        body: win.body,
        setTitle: (t) => { win.title = t; win.titleEl.textContent = t; bus.emit('wm:changed'); },
        close: () => this.close(win.id),
        focus: () => this.focus(win.id),
        isFocused: () => this.focusedId === win.id,
        flash: () => bus.emit('wm:attention', win.id),
      },
      app: win.app,
      args,
      api, store, bus, notify,
      open: (appId, a) => this.open(appId, a),
    };
    try {
      const result = mod.mount(win.body, ctx);
      Promise.resolve(result).then((r) => {
        if (typeof r === 'function') win.cleanup = r;
        else if (r && typeof r === 'object') { win.instance = r; win.cleanup = r.destroy; }
      }).finally(() => win.body.classList.remove('loading'));
    } catch (err) {
      console.error(err);
      win.body.classList.remove('loading');
      win.body.append(h('div', { style: { padding: '24px', color: 'var(--danger)' } }, `App crashed: ${err.message}`));
    }
  }

  focus(id) {
    if (id && !this.windows.has(id)) return;
    if (this.focusedId === id) return;
    for (const w of this.windows.values()) w.el.classList.toggle('focused', w.id === id);
    this.focusedId = id;
    if (id) {
      const w = this.windows.get(id);
      w.el.style.zIndex = ++zTop;
      w.instance?.onFocus?.();
    }
    bus.emit('wm:changed');
  }

  /** Focus the topmost visible window (after close/minimize). */
  #focusNext() {
    const next = this.list.filter((w) => !w.minimized).sort((a, b) => b.el.style.zIndex - a.el.style.zIndex)[0];
    this.focus(next ? next.id : null);
  }

  minimize(id) {
    const w = this.windows.get(id);
    if (!w || w.minimized) return;
    const target = document.querySelector(`.tb-item[data-app="${w.appId}"]`);
    const r = w.el.getBoundingClientRect();
    let transform = 'translateY(60px) scale(0.6)';
    if (target) {
      const t = target.getBoundingClientRect();
      const dx = t.left + t.width / 2 - (r.left + r.width / 2);
      const dy = t.top + t.height / 2 - (r.top + r.height / 2);
      transform = `translate(${dx}px, ${dy}px) scale(0.12)`;
    }
    w.el.style.setProperty('--min-transform', transform);
    this.#animate(w);
    w.el.classList.add('minimized');
    w.minimized = true;
    if (this.focusedId === id) this.#focusNext();
    bus.emit('wm:changed');
  }

  restore(id) {
    const w = this.windows.get(id);
    if (!w) return;
    if (w.minimized) {
      this.#animate(w);
      w.el.classList.remove('minimized');
      w.minimized = false;
    }
    this.focus(id);
    bus.emit('wm:changed');
  }

  /** Taskbar click semantics: focus → minimize → restore. */
  toggle(id) {
    const w = this.windows.get(id);
    if (!w) return;
    if (w.minimized) this.restore(id);
    else if (this.focusedId === id) this.minimize(id);
    else this.focus(id);
  }

  toggleMaximize(id) {
    const w = this.windows.get(id);
    if (!w) return;
    if (!w.maximized) w.prev = { width: w.el.offsetWidth, height: w.el.offsetHeight };
    this.#animate(w);
    w.maximized = !w.maximized;
    w.el.classList.toggle('maximized', w.maximized);
    w.maxBtn.innerHTML = w.maximized ? icons.restore : icons.maximize;
    w.maxBtn.title = w.maximized ? 'Restore' : 'Maximize';
    setTimeout(() => w.instance?.onResize?.(), 450);
  }

  close(id) {
    const w = this.windows.get(id);
    if (!w) return;
    const guard = w.instance?.beforeClose?.();
    if (guard === false) return;
    try { w.cleanup?.(); } catch (err) { console.error(err); }
    this.windows.delete(id);
    w.el.classList.add('closing');
    setTimeout(() => w.el.remove(), 220);
    if (this.focusedId === id) this.#focusNext();
    bus.emit('wm:changed');
  }

  closeApp(appId) {
    for (const w of this.byApp(appId)) this.close(w.id);
  }

  /** Show desktop: minimize all, or restore them if already shown. */
  toggleDesktop() {
    const visible = this.list.filter((w) => !w.minimized);
    if (visible.length) {
      this._peek = visible.map((w) => w.id);
      visible.forEach((w) => this.minimize(w.id));
    } else if (this._peek) {
      this._peek.forEach((id) => this.restore(id));
      this._peek = null;
    }
  }

  #animate(w) {
    w.el.classList.add('animating');
    clearTimeout(w._animT);
    w._animT = setTimeout(() => w.el.classList.remove('animating'), 450);
  }

  #titleMenu(e, w) {
    contextMenu.open(e.clientX, e.clientY, [
      { label: 'Restore', icon: 'restore', disabled: !w.maximized, action: () => this.toggleMaximize(w.id) },
      { label: 'Minimize', icon: 'minimize', action: () => this.minimize(w.id) },
      { label: 'Maximize', icon: 'maximize', disabled: w.maximized, action: () => this.toggleMaximize(w.id) },
      { label: 'Snap left', icon: 'arrowLeft', action: () => this.#applySnap(w, 'left') },
      { label: 'Snap right', icon: 'arrowRight', action: () => this.#applySnap(w, 'right') },
      '-',
      { label: 'Close', icon: 'close', kbd: 'Alt+W', danger: true, action: () => this.close(w.id) },
    ]);
  }

  // ─── drag + snap ────────────────────────────────────────────────────────
  #startDrag(e, w) {
    if (e.button !== 0 || e.target.closest('.win-controls')) return;
    e.preventDefault();
    const area = this.layer.getBoundingClientRect();
    const el = w.el;
    let rect = el.getBoundingClientRect();
    let offX = e.clientX - rect.left;
    let offY = e.clientY - rect.top;
    let started = false;
    let snap = null;
    const sx = e.clientX;
    const sy = e.clientY;

    const move = (ev) => {
      if (!started) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
        started = true;
        el.classList.add('dragging');
        if (w.maximized) {
          // Pull out of maximized state, keeping the cursor proportionally on the titlebar.
          const prev = w.prev || { width: 900, height: 600 };
          const ratio = offX / rect.width;
          w.maximized = false;
          el.classList.remove('maximized');
          w.maxBtn.innerHTML = icons.maximize;
          el.style.width = `${prev.width}px`;
          el.style.height = `${prev.height}px`;
          offX = prev.width * ratio;
          rect = el.getBoundingClientRect();
        } else if (w.snapped) {
          el.style.width = `${w.snapped.width}px`;
          el.style.height = `${w.snapped.height}px`;
          offX = Math.min(offX, w.snapped.width - 60);
          w.snapped = null;
        }
      }
      const x = ev.clientX - area.left - offX;
      const y = clamp(ev.clientY - area.top - offY, 0, area.height - 40);
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;

      const px = ev.clientX - area.left;
      const py = ev.clientY - area.top;
      snap = py < SNAP_EDGE ? 'max' : px < SNAP_EDGE ? 'left' : px > area.width - SNAP_EDGE ? 'right' : null;
      this.#showSnap(snap, area);
    };

    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      el.classList.remove('dragging');
      this.#showSnap(null);
      if (started && snap) this.#applySnap(w, snap);
      if (started) w.instance?.onResize?.();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  #showSnap(kind, area) {
    const s = this.snapEl;
    if (!kind) return s.classList.remove('show');
    const g = 6;
    const W = area.width;
    const H = area.height;
    const geo = kind === 'max' ? [g, g, W - 2 * g, H - 2 * g] : kind === 'left' ? [g, g, W / 2 - 1.5 * g, H - 2 * g] : [W / 2 + g / 2, g, W / 2 - 1.5 * g, H - 2 * g];
    Object.assign(s.style, { left: `${geo[0]}px`, top: `${geo[1]}px`, width: `${geo[2]}px`, height: `${geo[3]}px` });
    s.classList.add('show');
  }

  #applySnap(w, kind) {
    const area = this.layer.getBoundingClientRect();
    const el = w.el;
    if (!w.maximized) w.prev = { width: el.offsetWidth, height: el.offsetHeight };
    if (kind === 'max') {
      if (!w.maximized) this.toggleMaximize(w.id);
      return;
    }
    if (w.maximized) {
      w.maximized = false;
      el.classList.remove('maximized');
      w.maxBtn.innerHTML = icons.maximize;
    }
    w.snapped = { ...w.prev };
    this.#animate(w);
    const half = Math.round(area.width / 2);
    Object.assign(el.style, { left: `${kind === 'left' ? 0 : half}px`, top: '0px', width: `${half}px`, height: `${area.height}px` });
    setTimeout(() => w.instance?.onResize?.(), 450);
  }

  // ─── resize ─────────────────────────────────────────────────────────────
  #startResize(e, w, dir) {
    if (e.button !== 0 || w.maximized) return;
    e.preventDefault();
    e.stopPropagation();
    const el = w.el;
    const start = { x: e.clientX, y: e.clientY, l: el.offsetLeft, t: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
    el.classList.add('resizing');
    w.snapped = null;

    const move = (ev) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      let { l, t, w: width, h: height } = start;
      if (dir.includes('e')) width = Math.max(MIN_W, start.w + dx);
      if (dir.includes('s')) height = Math.max(MIN_H, start.h + dy);
      if (dir.includes('w')) { width = Math.max(MIN_W, start.w - dx); l = start.l + start.w - width; }
      if (dir.includes('n')) { height = Math.max(MIN_H, start.h - dy); t = Math.max(0, start.t + start.h - height); height = start.t + start.h - t; }
      Object.assign(el.style, { left: `${l}px`, top: `${t}px`, width: `${width}px`, height: `${height}px` });
      w.instance?.onResize?.();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      el.classList.remove('resizing');
      w.instance?.onResize?.();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /** Keep windows reachable when the viewport or taskbar edge changes. */
  #clampAll() {
    const area = this.layer.getBoundingClientRect();
    for (const w of this.windows.values()) {
      if (w.maximized) continue;
      const el = w.el;
      if (el.offsetWidth > area.width) el.style.width = `${Math.max(MIN_W, area.width)}px`;
      if (el.offsetHeight > area.height) el.style.height = `${Math.max(MIN_H, area.height)}px`;
      el.style.left = `${clamp(el.offsetLeft, -el.offsetWidth + 120, area.width - 120)}px`;
      el.style.top = `${clamp(el.offsetTop, 0, area.height - 40)}px`;
      w.instance?.onResize?.();
    }
  }

  relayout() {
    setTimeout(() => this.#clampAll(), 450);
  }
}

export const wm = new WindowManager();
