// Desktop: grid-snapped shortcuts, selection, drag & drop, context menu.

import { h, $, $$ } from './dom.js';
import { appIcon } from './icons.js';
import { bus } from './events.js';
import { store } from './store.js';
import { registry } from './registry.js';
import { wm } from './wm.js';
import { dnd } from './dnd.js';
import { contextMenu } from './contextmenu.js';
import { taskbar } from './taskbar.js';
import { api } from './api.js';
import { notify } from './notify.js';

const PAD = 12;
let root;
let ghost;
const selected = new Set();

function cellSize() {
  const cs = getComputedStyle(document.documentElement);
  return { w: parseFloat(cs.getPropertyValue('--icon-cell-w')) || 92, h: parseFloat(cs.getPropertyValue('--icon-cell-h')) || 96 };
}

function gridDims() {
  const { w, h: ch } = cellSize();
  return {
    cols: Math.max(1, Math.floor((root.clientWidth - PAD * 2) / w)),
    rows: Math.max(1, Math.floor((root.clientHeight - PAD * 2) / ch)),
    w, h: ch,
  };
}

const shortcuts = () => store.get('desktop.shortcuts') || [];
const save = (list) => store.set('desktop.shortcuts', list);

/** Pixel position → nearest grid cell, clamped to the grid. */
function cellAt(clientX, clientY) {
  const r = root.getBoundingClientRect();
  const g = gridDims();
  const col = Math.min(g.cols - 1, Math.max(0, Math.floor((clientX - r.left - PAD) / g.w)));
  const row = Math.min(g.rows - 1, Math.max(0, Math.floor((clientY - r.top - PAD) / g.h)));
  return { col, row };
}

function firstFreeCell(taken) {
  const g = gridDims();
  // Column-major like Windows: fill down, then across.
  for (let col = 0; col < g.cols; col++) {
    for (let row = 0; row < g.rows; row++) {
      if (!taken.has(`${col},${row}`)) return { col, row };
    }
  }
  return { col: 0, row: 0 };
}

export const desktop = {
  init() {
    root = $('#desktop');
    ghost = h('div.desk-grid-ghost', { hidden: true });

    store.watch('desktop', () => this.render());
    bus.on('registry:changed', () => this.render());
    bus.on('taskbar:layout', () => setTimeout(() => this.render(), 450));
    bus.on('desktop:add', ({ appId, col, row }) => this.add(appId, col, row));
    window.addEventListener('resize', () => this.render());

    root.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.desk-icon')) return;
      e.preventDefault();
      this.clearSelection();
      contextMenu.open(e.clientX, e.clientY, this.desktopMenu());
    });
    root.addEventListener('pointerdown', (e) => {
      if (e.target === root) this._rubberBand(e);
    });
    window.addEventListener('keydown', (e) => {
      if (document.activeElement?.closest('.window, input, textarea, [contenteditable]')) return;
      if (e.key === 'Delete' && selected.size) this.remove([...selected]);
      if (e.key === 'Enter' && selected.size) [...selected].forEach((id) => wm.open(id));
    });

    this._registerDropTarget();
    this.render();
  },

  render() {
    const g = gridDims();
    const taken = new Set();
    const list = shortcuts().filter((s) => registry.isInstalled(s.app));
    const placed = [];
    // Keep stored cells when they fit; otherwise flow into the next free slot.
    for (const s of list) {
      let { col, row } = s;
      if (col >= g.cols || row >= g.rows || taken.has(`${col},${row}`)) ({ col, row } = { col: -1, row: -1 });
      if (col >= 0) taken.add(`${col},${row}`);
      placed.push({ ...s, col, row });
    }
    for (const p of placed) {
      if (p.col < 0) {
        Object.assign(p, firstFreeCell(taken));
        taken.add(`${p.col},${p.row}`);
      }
    }

    const existing = new Map($$('.desk-icon', root).map((el) => [el.dataset.app, el]));
    for (const p of placed) {
      const app = registry.get(p.app);
      let el = existing.get(p.app);
      if (!el) {
        el = this._createIcon(app);
        root.append(el);
      }
      existing.delete(p.app);
      el.style.left = `${PAD + p.col * g.w + 4}px`;
      el.style.top = `${PAD + p.row * g.h + 4}px`;
      el.classList.toggle('selected', selected.has(p.app));
    }
    existing.forEach((el) => el.remove());
    if (!ghost.isConnected) root.append(ghost);
  },

  add(appId, col, row) {
    if (!registry.isInstalled(appId)) return;
    const list = shortcuts().filter((s) => s.app !== appId);
    if (col == null) {
      const taken = new Set(list.map((s) => `${s.col},${s.row}`));
      ({ col, row } = firstFreeCell(taken));
    }
    list.push({ app: appId, col, row });
    save(list);
  },

  remove(appIds) {
    save(shortcuts().filter((s) => !appIds.includes(s.app)));
    appIds.forEach((id) => selected.delete(id));
  },

  clearSelection() {
    selected.clear();
    $$('.desk-icon.selected', root).forEach((el) => el.classList.remove('selected'));
  },

  select(appId, additive = false) {
    if (!additive) this.clearSelection();
    selected.add(appId);
    root.querySelector(`.desk-icon[data-app="${appId}"]`)?.classList.add('selected');
  },

  sortByName() {
    const g = gridDims();
    const list = [...shortcuts()].sort((a, b) => registry.get(a.app)?.name.localeCompare(registry.get(b.app)?.name));
    save(list.map((s, i) => ({ app: s.app, col: Math.floor(i / g.rows), row: i % g.rows })));
  },

  desktopMenu() {
    const tb = store.get('taskbar');
    return [
      { label: 'View', icon: 'grid', submenu: [
        { label: 'Show widgets', checked: !document.body.classList.contains('widgets-hidden'), action: () => bus.emit('widgets:toggle') },
        { label: 'Animated wallpaper', checked: store.get('theme.animateWallpaper'), action: () => store.set('theme.animateWallpaper', !store.get('theme.animateWallpaper')) },
      ] },
      { label: 'Sort by name', icon: 'sort', action: () => this.sortByName() },
      { label: 'Refresh', icon: 'refresh', action: () => { root.style.opacity = 0.4; setTimeout(() => { root.style.opacity = ''; this.render(); }, 120); } },
      '-',
      { label: 'New text document', icon: 'file', action: () => this.newDocument() },
      { label: 'Open in Terminal', icon: 'terminal', disabled: !registry.isInstalled('terminal'), action: () => wm.open('terminal') },
      '-',
      { label: 'Taskbar position', icon: 'taskbar', submenu: ['bottom', 'top', 'left', 'right'].map((p) => ({
        label: p[0].toUpperCase() + p.slice(1), checked: tb.position === p, action: () => taskbar.setPosition(p),
      })) },
      { label: 'Personalize', icon: 'palette', action: () => wm.open('settings', { page: 'personalization' }) },
    ];
  },

  async newDocument() {
    const name = `New Text Document ${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.txt`;
    try {
      await api.files.write(name, '');
      wm.open('notepad', { file: name });
    } catch {
      wm.open('notepad');
    }
  },

  _createIcon(app) {
    const el = h('button.desk-icon', { dataset: { app: app.id }, title: app.description }, appIcon(app), h('span', app.name));
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      if (!selected.has(app.id) || e.ctrlKey) this.select(app.id, e.ctrlKey);
      dnd.track(e, { appId: app.id, source: 'desktop', sourceEl: el });
    });
    el.addEventListener('dblclick', () => wm.open(app.id));
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.stopPropagation(); wm.open(app.id); } });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.select(app.id);
      const pinned = taskbar.isPinned(app.id);
      contextMenu.open(e.clientX, e.clientY, [
        { label: 'Open', icon: 'open', action: () => wm.open(app.id) },
        { label: pinned ? 'Unpin from taskbar' : 'Pin to taskbar', icon: pinned ? 'unpin' : 'pin', action: () => (pinned ? taskbar.unpin(app.id) : taskbar.pin(app.id)) },
        '-',
        { label: 'Remove shortcut', icon: 'trash', danger: true, kbd: 'Del', action: () => this.remove([app.id]) },
      ]);
    });
    return el;
  },

  _registerDropTarget() {
    const occupant = (col, row, except) => shortcuts().find((s) => s.col === col && s.row === row && s.app !== except);
    dnd.register({
      el: root,
      accepts: (p) => registry.isInstalled(p.appId),
      // Only when the pointer is actually over bare desktop (not a window/widget).
      hitTest: (x, y) => {
        const top = document.elementFromPoint(x, y);
        return !!top && root.contains(top);
      },
      label: (p) => (p.source === 'desktop' ? 'Move' : 'Create shortcut'),
      over: (p, x, y) => {
        const { col, row } = cellAt(x, y);
        const g = gridDims();
        ghost.hidden = false;
        ghost.style.left = `${PAD + col * g.w + 4}px`;
        ghost.style.top = `${PAD + row * g.h + 4}px`;
        root.classList.toggle('drop-target', p.source !== 'desktop');
      },
      leave: () => {
        ghost.hidden = true;
        root.classList.remove('drop-target');
      },
      drop: (p, x, y) => {
        const { col, row } = cellAt(x, y);
        const list = shortcuts();
        const current = list.find((s) => s.app === p.appId);
        const other = occupant(col, row, p.appId);
        if (p.source === 'desktop' && current) {
          // Swap with whatever sits in the target cell.
          if (other) Object.assign(other, { col: current.col, row: current.row });
          Object.assign(current, { col, row });
          save([...list]);
        } else {
          if (other) {
            const taken = new Set(list.map((s) => `${s.col},${s.row}`));
            Object.assign(other, firstFreeCell(taken));
          }
          const next = list.filter((s) => s.app !== p.appId);
          next.push({ app: p.appId, col, row });
          save(next);
          if (!current) notify('Shortcut created', registry.get(p.appId).name, { timeout: 2000 });
        }
      },
    });
  },

  _rubberBand(e) {
    if (e.button !== 0) return;
    this.clearSelection();
    const r = root.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const box = h('div.select-box');
    let active = false;
    const move = (ev) => {
      const x = ev.clientX - r.left;
      const y = ev.clientY - r.top;
      if (!active && Math.hypot(x - sx, y - sy) < 4) return;
      if (!active) { root.append(box); active = true; }
      const L = Math.min(sx, x), T = Math.min(sy, y), W = Math.abs(x - sx), H = Math.abs(y - sy);
      Object.assign(box.style, { left: `${L}px`, top: `${T}px`, width: `${W}px`, height: `${H}px` });
      for (const icon of $$('.desk-icon', root)) {
        const hit = icon.offsetLeft < L + W && icon.offsetLeft + icon.offsetWidth > L && icon.offsetTop < T + H && icon.offsetTop + icon.offsetHeight > T;
        icon.classList.toggle('selected', hit);
        hit ? selected.add(icon.dataset.app) : selected.delete(icon.dataset.app);
      }
    };
    const up = () => {
      box.remove();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  },
};
