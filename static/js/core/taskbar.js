// Taskbar: docking (bottom/top/left/right), pinned + running app items,
// drag-to-pin / drag-to-desktop, tray (network, volume, clock) and flyouts.

import { h, $, $$, syncRange } from './dom.js';
import { icons, appIcon } from './icons.js';
import { bus } from './events.js';
import { store } from './store.js';
import { registry } from './registry.js';
import { wm } from './wm.js';
import { dnd } from './dnd.js';
import { contextMenu } from './contextmenu.js';
import { flyouts } from './flyouts.js';
import { system } from './system.js';
import { api, online } from './api.js';
import { notify } from './notify.js';

const POSITIONS = ['bottom', 'top', 'left', 'right'];
let itemsEl;
let preview;
let netOnline = online;

export const taskbar = {
  init() {
    itemsEl = $('#tb-items');
    $('#start-btn').innerHTML = icons.logo;
    $('#show-desktop').addEventListener('click', () => wm.toggleDesktop());

    this.applyLayout(store.get('taskbar'));
    store.watch('taskbar', (tb) => {
      this.applyLayout(tb);
      this.render();
    });
    bus.on('wm:changed', () => this.render());
    bus.on('registry:changed', () => this.render());
    bus.on('wm:attention', (id) => {
      const w = wm.windows.get(id);
      itemsEl.querySelector(`[data-app="${w?.appId}"]`)?.classList.add('attention');
    });

    $('#taskbar').addEventListener('contextmenu', (e) => {
      if (e.target.closest('.tb-item')) return;
      e.preventDefault();
      contextMenu.open(e.clientX, e.clientY, this.taskbarMenu());
    });

    this._setupDropTarget();
    this._setupTray();
    this.render();
  },

  setPosition(pos) {
    if (!POSITIONS.includes(pos)) return;
    store.set('taskbar.position', pos);
  },

  applyLayout(tb) {
    const body = document.body;
    for (const p of POSITIONS) body.classList.toggle(`tb-${p}`, tb.position === p);
    body.classList.toggle('tb-centered', !!tb.centered);
    body.classList.toggle('tb-autohide', !!tb.autoHide);
    flyouts.close(true);
    wm.relayout();
    bus.emit('taskbar:layout', tb);
  },

  taskbarMenu() {
    const tb = store.get('taskbar');
    return [
      { heading: 'Taskbar' },
      {
        label: 'Taskbar position', icon: 'taskbar', submenu: POSITIONS.map((p) => ({
          label: p[0].toUpperCase() + p.slice(1), checked: tb.position === p,
          icon: { bottom: 'arrowDown', top: 'arrowUp', left: 'arrowLeft', right: 'arrowRight' }[p],
          action: () => this.setPosition(p),
        })),
      },
      { label: 'Center icons', icon: 'grid', checked: tb.centered, action: () => store.set('taskbar.centered', !tb.centered) },
      { label: 'Automatically hide', icon: 'eye', checked: tb.autoHide, action: () => store.set('taskbar.autoHide', !tb.autoHide) },
      '-',
      { label: 'Show desktop', icon: 'desktop', action: () => wm.toggleDesktop() },
      '-',
      { label: 'Taskbar settings', icon: 'settings', action: () => wm.open('settings', { page: 'taskbar' }) },
    ];
  },

  /** Pin/unpin helpers used by the desktop, start menu and app store. */
  pin(appId, index = -1) {
    const pinned = store.get('taskbar.pinned').filter((id) => id !== appId);
    if (index < 0 || index > pinned.length) pinned.push(appId);
    else pinned.splice(index, 0, appId);
    store.set('taskbar.pinned', pinned);
  },

  unpin(appId) {
    store.set('taskbar.pinned', store.get('taskbar.pinned').filter((id) => id !== appId));
  },

  isPinned: (appId) => store.get('taskbar.pinned').includes(appId),

  render() {
    const pinned = store.get('taskbar.pinned').filter((id) => registry.isInstalled(id));
    const running = [...new Set(wm.list.map((w) => w.appId))];
    const order = [...pinned, ...running.filter((id) => !pinned.includes(id))];
    const focusedApp = wm.windows.get(wm.focusedId)?.appId;

    const existing = new Map($$('.tb-item', itemsEl).map((el) => [el.dataset.app, el]));
    const next = order.map((id) => {
      const app = registry.get(id);
      if (!app) return null;
      const el = existing.get(id) || this._createItem(app);
      existing.delete(id);
      const count = wm.byApp(id).length;
      el.classList.toggle('running', count > 0);
      el.classList.toggle('focused', focusedApp === id);
      el.querySelector('.tb-count')?.remove();
      if (count > 1) el.append(h('span.tb-count', String(count)));
      return el;
    }).filter(Boolean);
    existing.forEach((el) => el.remove());
    // Re-append in order (moves nodes without recreating them).
    next.forEach((el, i) => {
      if (itemsEl.children[i] !== el) itemsEl.insertBefore(el, itemsEl.children[i] || null);
    });
  },

  _createItem(app) {
    const el = h('button.tb-btn.tb-item', { dataset: { app: app.id }, 'aria-label': app.name }, appIcon(app));
    el.addEventListener('click', () => {
      if (dnd.suppressClick) return;
      el.classList.remove('attention');
      const wins = wm.byApp(app.id);
      if (!wins.length) return wm.open(app.id);
      if (wins.length === 1) return wm.toggle(wins[0].id);
      // Cycle through this app's windows.
      const idx = wins.findIndex((w) => w.id === wm.focusedId);
      const target = wins[(idx + 1) % wins.length];
      wm.restore(target.id);
    });
    el.addEventListener('auxclick', (e) => { if (e.button === 1) wm.open(app.id); });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._hidePreview();
      contextMenu.open(e.clientX, e.clientY, this._itemMenu(app));
    });
    el.addEventListener('pointerdown', (e) => {
      this._hidePreview();
      dnd.track(e, { appId: app.id, source: 'taskbar', sourceEl: el });
    });
    el.addEventListener('pointerenter', () => this._showPreview(el, app));
    el.addEventListener('pointerleave', () => this._hidePreview());
    return el;
  },

  _itemMenu(app) {
    const wins = wm.byApp(app.id);
    const pinned = this.isPinned(app.id);
    return [
      { heading: app.name },
      ...wins.map((w) => ({ label: w.title, icon: 'restore', action: () => wm.restore(w.id) })),
      wins.length ? '-' : null,
      { label: wins.length ? 'New window' : 'Open', icon: 'plus', action: () => wm.open(app.id) },
      { label: pinned ? 'Unpin from taskbar' : 'Pin to taskbar', icon: pinned ? 'unpin' : 'pin', action: () => (pinned ? this.unpin(app.id) : this.pin(app.id)) },
      { label: 'Create desktop shortcut', icon: 'desktop', action: () => bus.emit('desktop:add', { appId: app.id }) },
      wins.length ? '-' : null,
      wins.length ? { label: wins.length > 1 ? 'Close all windows' : 'Close window', icon: 'close', danger: true, action: () => wm.closeApp(app.id) } : null,
    ];
  },

  _showPreview(el, app) {
    if (dnd.active) return;
    this._hidePreview();
    const wins = wm.byApp(app.id);
    preview = h('div.tb-preview', h('b', app.name), ...wins.map((w) => h('div', { style: { color: 'var(--text-2)' } }, `• ${w.title}`)));
    document.body.append(preview);
    const r = el.getBoundingClientRect();
    const p = preview.getBoundingClientRect();
    const pos = store.get('taskbar.position');
    const left = pos === 'left' ? r.right + 12 : pos === 'right' ? r.left - p.width - 12 : r.left + r.width / 2 - p.width / 2;
    const top = pos === 'top' ? r.bottom + 12 : pos === 'bottom' ? r.top - p.height - 12 : r.top + r.height / 2 - p.height / 2;
    preview.style.left = `${Math.max(6, Math.min(innerWidth - p.width - 6, left))}px`;
    preview.style.top = `${Math.max(6, top)}px`;
  },

  _hidePreview() {
    preview?.remove();
    preview = null;
  },

  // Dropping an app onto the taskbar pins it at the pointer position.
  _setupDropTarget() {
    const marker = h('div.tb-drop-marker');
    const vertical = () => ['left', 'right'].includes(store.get('taskbar.position'));
    const indexAt = (x, y) => {
      const items = $$('.tb-item', itemsEl).filter((el) => !el.classList.contains('dragging'));
      const i = items.findIndex((el) => {
        const r = el.getBoundingClientRect();
        return vertical() ? y < r.top + r.height / 2 : x < r.left + r.width / 2;
      });
      return { i: i < 0 ? items.length : i, items };
    };
    dnd.register({
      el: $('#taskbar'),
      accepts: (p) => registry.isInstalled(p.appId),
      label: (p) => (p.source === 'taskbar' ? 'Move' : `Pin ${registry.get(p.appId).name}`),
      over(p, x, y) {
        const { i, items } = indexAt(x, y);
        itemsEl.classList.add('drop-target');
        itemsEl.insertBefore(marker, items[i] || null);
      },
      leave() {
        marker.remove();
        itemsEl.classList.remove('drop-target');
      },
      drop: (p, x, y) => {
        // Index among pinned apps only (running-but-unpinned sit at the end).
        const { i, items } = indexAt(x, y);
        const pinned = store.get('taskbar.pinned');
        const before = items.slice(0, i).map((el) => el.dataset.app).filter((id) => pinned.includes(id) && id !== p.appId);
        const wasPinned = pinned.includes(p.appId);
        this.pin(p.appId, before.length);
        if (!wasPinned) notify('Pinned to taskbar', registry.get(p.appId).name, { timeout: 2000 });
      },
    });
  },

  // ─── tray ───────────────────────────────────────────────────────────────
  _setupTray() {
    const net = $('#tray-net');
    const vol = $('#tray-vol');
    const renderTray = () => {
      const connected = navigator.onLine && netOnline;
      net.innerHTML = connected ? icons.wifi : icons.wifiOff;
      net.title = !navigator.onLine ? 'No internet connection' : netOnline ? 'Connected' : 'Orion OS server unreachable';
      vol.innerHTML = system.muted || system.volume === 0 ? icons.mute : system.volume < 50 ? icons.volumeLow : icons.volume;
      vol.title = `Volume: ${system.muted ? 'muted' : `${system.volume}%`}`;
    };
    renderTray();
    bus.on('system:volume', renderTray);
    bus.on('net', (v) => { netOnline = v; renderTray(); });
    window.addEventListener('online', renderTray);
    window.addEventListener('offline', renderTray);

    const time = $('#clock-time');
    const date = $('#clock-date');
    const tick = () => {
      const now = new Date();
      time.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      date.textContent = now.toLocaleDateString([], { day: 'numeric', month: 'numeric', year: 'numeric' });
    };
    tick();
    setInterval(tick, 1000);

    const qsBtn = $('#tray-quick');
    const qs = $('#quick-settings');
    qsBtn.addEventListener('click', () => flyouts.toggle(qs, qsBtn, { onOpen: () => this._renderQuickSettings(qs) }));
    qsBtn.addEventListener('wheel', (e) => {
      e.preventDefault();
      system.setVolume(Math.max(0, Math.min(100, system.volume - Math.sign(e.deltaY) * 5)));
    }, { passive: false });

    const calBtn = $('#tray-clock');
    const cal = $('#calendar-flyout');
    calBtn.addEventListener('click', () => flyouts.toggle(cal, calBtn, { onOpen: () => renderCalendar(cal) }));
  },

  /** Network status (real measurements) + master volume. */
  _renderQuickSettings(el) {
    const conn = navigator.connection;
    const latency = h('b', '…');
    const row = (label, value) => h('div.qs-row', h('span', label), value instanceof Node ? value : h('b', value));
    const range = h('input', { type: 'range', min: 0, max: 100, value: system.volume, 'aria-label': 'Volume' });
    const muteBtn = h('button.icon-btn', { html: system.muted ? icons.mute : icons.volume, title: 'Mute' });
    syncRange(range);
    range.addEventListener('input', () => { system.setVolume(+range.value); syncRange(range); muteBtn.innerHTML = icons[system.volume ? 'volume' : 'mute']; });
    muteBtn.addEventListener('click', () => { system.toggleMute(); muteBtn.innerHTML = system.muted ? icons.mute : icons.volume; });

    el.replaceChildren(
      h('div.qs-head', h('span', { html: navigator.onLine ? icons.wifi : icons.wifiOff }), h('div', h('b', navigator.onLine ? 'Connected' : 'Offline'), h('small', netOnline ? 'Orion OS server reachable' : 'Orion OS server unreachable'))),
      h('div.qs-rows',
        row('Server latency', latency),
        conn?.effectiveType ? row('Connection', conn.effectiveType.toUpperCase()) : null,
        conn?.downlink ? row('Estimated downlink', `${conn.downlink} Mb/s`) : null,
        conn?.rtt ? row('Network RTT', `${conn.rtt} ms`) : null,
      ),
      h('div.qs-slider', muteBtn, range),
      h('div.qs-footer',
        h('span', 'Master volume applies to media apps'),
        h('button.icon-btn', { html: icons.settings, title: 'All settings', onclick: () => { flyouts.close(); wm.open('settings'); } }),
      ),
    );
    api.latency(3).then((ms) => (latency.textContent = `${ms} ms`)).catch(() => (latency.textContent = 'unreachable'));
  },
};

function renderCalendar(el) {
  const now = new Date();
  let view = new Date(now.getFullYear(), now.getMonth(), 1);
  const draw = () => {
    const first = (view.getDay() + 6) % 7; // Monday-first
    const days = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
    const prevDays = new Date(view.getFullYear(), view.getMonth(), 0).getDate();
    const cells = [];
    for (let i = first - 1; i >= 0; i--) cells.push(h('span.muted', String(prevDays - i)));
    for (let d = 1; d <= days; d++) {
      const today = d === now.getDate() && view.getMonth() === now.getMonth() && view.getFullYear() === now.getFullYear();
      cells.push(h(`span${today ? '.today' : ''}`, String(d)));
    }
    while (cells.length % 7) cells.push(h('span.muted', String(cells.length - first - days + 1)));
    el.replaceChildren(
      h('div.cal-big', now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
      h('div', { style: { color: 'var(--text-2)', marginBottom: '14px' } }, now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })),
      h('div.cal-head',
        h('b', view.toLocaleDateString([], { month: 'long', year: 'numeric' })),
        h('div', { style: { display: 'flex' } },
          h('button.icon-btn', { html: icons.chevronLeft, onclick: () => { view = new Date(view.getFullYear(), view.getMonth() - 1, 1); draw(); } }),
          h('button.icon-btn', { html: icons.chevronRight, onclick: () => { view = new Date(view.getFullYear(), view.getMonth() + 1, 1); draw(); } }),
        ),
      ),
      h('div.cal-grid', ...['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((d) => h('b', d)), ...cells),
    );
  };
  draw();
}
