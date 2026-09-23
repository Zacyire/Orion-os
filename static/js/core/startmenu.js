// Start menu: search, pinned/all apps grid, recommended files, power options.

import { h, $, escapeHtml } from './dom.js';
import { icons, appIcon } from './icons.js';
import { registry } from './registry.js';
import { wm } from './wm.js';
import { flyouts } from './flyouts.js';
import { contextMenu } from './contextmenu.js';
import { dnd } from './dnd.js';
import { bus } from './events.js';
import { api } from './api.js';
import { taskbar } from './taskbar.js';
import { power } from './power.js';
import { store } from './store.js';
import { avatar } from './user.js';

let el;
let btn;
let showAll = false;

export const startMenu = {
  init() {
    el = $('#start-menu');
    btn = $('#start-btn');
    btn.addEventListener('click', () => this.toggle());
    bus.on('registry:changed', () => { if (!el.hidden) this.render(); });
  },

  toggle() {
    flyouts.toggle(el, btn, { onOpen: () => this.render() });
  },

  open() {
    flyouts.open(el, btn, { onOpen: () => this.render() });
  },

  render() {
    const input = h('input', { type: 'search', placeholder: 'Type here to search apps and files', 'aria-label': 'Search' });
    const body = h('div.sm-body');
    const search = h('div.sm-search', h('span', { html: icons.search }), input);

    const drawHome = async () => {
      const apps = registry.installed().sort((a, b) => (showAll ? a.name.localeCompare(b.name) : 0));
      body.replaceChildren(
        h('div.sm-heading', showAll ? 'All apps' : 'Pinned',
          h('div', { style: { display: 'flex', gap: '4px' } },
            h('button.btn.ghost', { title: 'Create a web app', onclick: () => { flyouts.close(); wm.open('appstore', { addWebApp: true }); } }, '+ New Web App…'),
            h('button.btn.ghost', { onclick: () => { showAll = !showAll; drawHome(); } }, showAll ? '‹ Back' : 'All apps ›'))),
        showAll
          ? h('div', apps.map((a) => listItem(a)))
          : h('div.sm-grid', apps.map((a) => gridItem(a))),
      );
      if (showAll) return;
      const recent = h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px' } });
      body.append(h('div.sm-heading', 'Recent documents', h('small', 'Notepad')), recent);
      try {
        const files = (await api.files.list()).slice(0, 6);
        recent.append(...files.map((f) => {
          const b = h('button.sm-list-item',
            h('span', { html: icons.file, style: { width: '28px', color: 'var(--accent-color-2)' } }),
            h('div', f.name, h('small', timeAgo(f.modified))),
          );
          b.addEventListener('click', () => { flyouts.close(); wm.open('notepad', { file: f.name }); });
          return b;
        }));
        if (!files.length) recent.append(h('small', { style: { color: 'var(--text-3)', padding: '0 12px' } }, 'No documents yet.'));
      } catch {
        recent.append(h('small', { style: { color: 'var(--text-3)', padding: '0 12px' } }, 'Server offline — documents unavailable.'));
      }
    };

    const drawResults = (q) => {
      const needle = q.toLowerCase();
      const matches = registry.all().filter((a) => `${a.name} ${a.category} ${a.description}`.toLowerCase().includes(needle));
      body.replaceChildren(
        h('div.sm-heading', 'Best match'),
        matches.length ? h('div', matches.map((a, i) => listItem(a, i === 0))) : h('p', { style: { padding: '0 12px', color: 'var(--text-2)' }, html: `No results for “${escapeHtml(q)}”.` }),
      );
    };

    input.addEventListener('input', () => (input.value.trim() ? drawResults(input.value.trim()) : drawHome()));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') body.querySelector('.kb-active, .sm-list-item, .sm-app')?.click();
    });

    const footer = h('div.sm-footer',
      h('button.sm-user', { onclick: () => { flyouts.close(); wm.open('settings', { page: 'account' }); } }, avatar(), h('span', store.get('user.name') || 'User')),
      h('button.icon-btn.sm-power', { html: icons.power, title: 'Power', onclick: (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        contextMenu.open(r.left, r.top - 130, [
          { label: 'Lock', icon: 'lock', action: () => power.lock() },
          { label: 'Restart', icon: 'restart', action: () => power.restart() },
          { label: 'Shut down', icon: 'power', danger: true, action: () => power.shutdown() },
        ]);
      } }),
    );

    el.replaceChildren(search, body, footer);
    drawHome();
    requestAnimationFrame(() => input.focus());
  },
};

function launch(app) {
  flyouts.close();
  wm.open(app.id);
}

function appMenu(e, app) {
  e.preventDefault();
  const pinned = taskbar.isPinned(app.id);
  contextMenu.open(e.clientX, e.clientY, [
    { label: 'Open', icon: 'open', action: () => launch(app) },
    { label: pinned ? 'Unpin from taskbar' : 'Pin to taskbar', icon: pinned ? 'unpin' : 'pin', action: () => (pinned ? taskbar.unpin(app.id) : taskbar.pin(app.id)) },
    { label: 'Add to desktop', icon: 'desktop', action: () => bus.emit('desktop:add', { appId: app.id }) },
    app.system ? null : '-',
    app.system ? null : { label: 'Uninstall', icon: 'trash', danger: true, action: () => wm.open('appstore', { focus: app.id }) },
  ]);
}

function wire(elm, app) {
  elm.addEventListener('click', () => { if (!dnd.suppressClick) launch(app); });
  elm.addEventListener('contextmenu', (e) => appMenu(e, app));
  elm.addEventListener('pointerdown', (e) => dnd.track(e, { appId: app.id, source: 'start', sourceEl: elm }));
  return elm;
}

const gridItem = (app) => wire(h('button.sm-app', { title: app.description }, appIcon(app), h('span', app.name)), app);
const listItem = (app, active = false) =>
  wire(h(`button.sm-list-item${active ? '.kb-active' : ''}`, appIcon(app, 'md'), h('div', app.name, h('small', `${app.category} · ${app.developer}`))), app);

function timeAgo(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}
