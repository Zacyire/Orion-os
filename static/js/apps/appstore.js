// App Store — browse, install, uninstall and launch apps from the registry.
import { h, fill } from '../core/dom.js';
import { icons, appIcon, tileColors } from '../core/icons.js';
import { registry } from '../core/registry.js';
import { taskbar } from '../core/taskbar.js';

const CATS = [
  { id: 'home', label: 'Home', icon: 'store' },
  { id: 'Productivity', label: 'Productivity', icon: 'notepad' },
  { id: 'Entertainment', label: 'Entertainment', icon: 'movies' },
  { id: 'Games', label: 'Games', icon: 'games' },
  { id: 'Utilities', label: 'Utilities', icon: 'calculator' },
  { id: 'Creativity', label: 'Creativity', icon: 'paint' },
  { id: 'Developer', label: 'Developer', icon: 'code' },
  { id: 'System', label: 'System', icon: 'settings' },
  { id: 'library', label: 'Library', icon: 'grid' },
];

export default {
  single: true,

  mount(root, ctx) {
    let cat = 'home';
    let query = '';
    let focusId = ctx.args.focus || null;
    const installing = new Map(); // id → progress 0..100

    const search = h('input.field', { type: 'search', placeholder: 'Search apps, games…', style: { maxWidth: '360px' } });
    const nav = h('nav.app-sidebar');
    const main = h('div.app-main');
    root.append(h('div.app',
      h('div.app-toolbar', h('b', { style: { padding: '0 8px' } }, 'App Store'), h('span.spacer'), search, h('span.spacer')),
      h('div.app-row', nav, main),
    ));
    search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); draw(); });

    const stars = (r) => h('span.stars', { html: icons.star }, r.toFixed(1));

    function actions(app) {
      if (installing.has(app.id)) {
        const pct = installing.get(app.id);
        return h('div.store-actions', h('div.install-bar', h('i', { style: { width: `${pct}%` } }), h('span', `Installing… ${pct}%`)));
      }
      if (!app.installed) {
        return h('div.store-actions', h('button.btn.primary', { onclick: () => install(app) }, h('span', { html: icons.download }), 'Get'));
      }
      return h('div.store-actions',
        h('button.btn.primary', { onclick: () => ctx.open(app.id) }, 'Open'),
        app.system ? null : h('button.btn', { title: 'Uninstall', onclick: () => uninstall(app), html: icons.trash }),
      );
    }

    function card(app) {
      return h(`article.store-card${focusId === app.id ? '.highlight' : ''}`, { dataset: { id: app.id } },
        h('header', appIcon(app, 'md'), h('div', h('h4', app.name), h('small.muted', app.developer))),
        h('p', app.description),
        h('div.store-meta', stars(app.rating), h('span', app.category), h('span', `${app.size_mb} MB`), app.installed ? h('span.chip.accent', 'Installed') : null),
        actions(app),
      );
    }

    async function install(app) {
      installing.set(app.id, 0);
      draw();
      // Simulated download progress; the real install is a single API call.
      const size = app.size_mb;
      for (let p = 0; p < 100; p += Math.max(3, Math.round(40 / size + Math.random() * 12))) {
        installing.set(app.id, p);
        refreshCard(app.id);
        await new Promise((r) => setTimeout(r, 90));
      }
      try {
        await registry.install(app.id);
        ctx.notify(`${app.name} installed`, 'Find it in Start or drag it to your taskbar.', { type: 'success' });
      } catch (e) {
        ctx.notify('Install failed', e.message, { type: 'error' });
      }
      installing.delete(app.id);
      draw();
    }

    async function uninstall(app) {
      try {
        ctx.bus.emit('wm:close-app', app.id);
        await registry.uninstall(app.id);
        if (taskbar.isPinned(app.id)) taskbar.unpin(app.id);
        ctx.notify(`${app.name} uninstalled`);
      } catch (e) {
        ctx.notify('Uninstall failed', e.message, { type: 'error' });
      }
      draw();
    }

    function refreshCard(id) {
      const el = main.querySelector(`.store-card[data-id="${id}"]`);
      if (el) el.replaceWith(card(registry.get(id)));
    }

    function draw() {
      nav.replaceChildren(...CATS.map((c) => {
        const b = h(`button.nav-item${cat === c.id ? '.active' : ''}`, { html: icons[c.icon] }, c.label);
        b.addEventListener('click', () => { cat = c.id; focusId = null; search.value = query = ''; draw(); });
        return b;
      }));

      const all = registry.all();
      if (query) {
        const hits = all.filter((a) => `${a.name} ${a.description} ${a.category} ${a.developer}`.toLowerCase().includes(query));
        main.replaceChildren(h('h1.page-title', `Results for “${query}”`), hits.length ? h('div.store-grid', hits.map(card)) : h('div.empty', 'Nothing found.'));
        return;
      }

      if (cat === 'home') {
        const featured = registry.get('cloud') || all[0];
        const [a, b] = tileColors[featured.id] || ['#7c5cff', '#00d4ff'];
        const hero = h('section.store-hero', { style: { '--hero-a': a, '--hero-b': b } },
          appIcon(featured, 'xl'),
          h('div', h('small', { style: { textTransform: 'uppercase', letterSpacing: '.1em', opacity: 0.8 } }, 'Featured'),
            h('h2', featured.name), h('p', featured.description), actions(featured)),
        );
        hero.style.setProperty('--hero-a', a);
        hero.style.setProperty('--hero-b', b);
        const top = [...all].sort((x, y) => y.rating - x.rating).slice(0, 4);
        const notInstalled = all.filter((x) => !x.installed);
        fill(main,
          hero,
          h('div.section-title', 'Top rated'), h('div.store-grid', top.map(card)),
          notInstalled.length ? h('div.section-title', 'Discover') : null,
          notInstalled.length ? h('div.store-grid', notInstalled.map(card)) : null,
          h('div.section-title', 'Everything'), h('div.store-grid', all.map(card)),
        );
      } else if (cat === 'library') {
        const mine = all.filter((x) => x.installed);
        main.replaceChildren(h('h1.page-title', 'Library'), h('p.muted', `${mine.length} apps installed`), h('div.store-grid', mine.map(card)));
      } else {
        const list = all.filter((x) => x.category === cat);
        main.replaceChildren(h('h1.page-title', cat), list.length ? h('div.store-grid', list.map(card)) : h('div.empty', 'No apps here yet.'));
      }

      if (focusId) {
        requestAnimationFrame(() => main.querySelector(`.store-card[data-id="${focusId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      }
    }

    draw();
    const off = ctx.bus.on('registry:changed', () => { if (!installing.size) draw(); });
    return {
      onArgs(a) { if (a.focus) { focusId = a.focus; cat = 'home'; draw(); } },
      destroy: off,
    };
  },
};
