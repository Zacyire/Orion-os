// App Store — browse, install, uninstall and launch apps from the registry.
import { h, fill } from '../core/dom.js';
import { icons, appIcon } from '../core/icons.js';
import { registry, PERMISSIONS, PERMISSION_LABELS } from '../core/registry.js';
import { taskbar } from '../core/taskbar.js';
import { RUNTIME_DEFS, normalizeRuntime } from '../core/runtimes.js';

const CATS = [
  { id: 'home', label: 'Home', icon: 'store' },
  { id: 'Entertainment', label: 'Entertainment', icon: 'play2' },
  { id: 'Games', label: 'Games', icon: 'gamepad' },
  { id: 'Internet', label: 'Internet', icon: 'globe' },
  { id: 'Productivity', label: 'Productivity', icon: 'notepad' },
  { id: 'Web', label: 'Web apps', icon: 'tab' },
  { id: 'System', label: 'System', icon: 'settings' },
  { id: 'library', label: 'Installed', icon: 'grid' },
];

export default {
  single: true,

  mount(root, ctx) {
    let cat = 'home';
    let query = '';
    let catCat = 'all'; // catalog category filter (Home view), generated from catalog data
    let focusId = ctx.args.focus || null;
    const installing = new Map(); // id → progress 0..100

    const search = h('input.field', { type: 'search', placeholder: 'Search apps', style: { maxWidth: '360px' } });
    const nav = h('nav.app-sidebar');
    const main = h('div.app-main');
    root.append(h('div.app',
      h('div.app-toolbar', h('b', { style: { padding: '0 8px' } }, 'App Store'), h('span.spacer'), search, h('span.spacer'),
        h('button.btn.primary', { onclick: () => addWebApp() }, h('span', { html: icons.plus }), 'Add web app')),
      h('div.app-row', nav, main),
    ));
    search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); draw(); });

    function actions(app) {
      if (installing.has(app.id)) {
        const pct = installing.get(app.id);
        return h('div.store-actions', h('div.install-bar', h('i', { style: { width: `${pct}%` } }), h('span', `Installing… ${pct}%`)));
      }
      if (app.fromCatalog && !app.installed) {
        return h('div.store-actions', h('button.btn.primary', { onclick: () => installCatalog(app) }, h('span', { html: icons.download }), 'Install'));
      }
      if (!app.installed) {
        return h('div.store-actions', h('button.btn.primary', { onclick: () => install(app) }, h('span', { html: icons.download }), 'Get'));
      }
      return h('div.store-actions',
        h('button.btn.primary', { onclick: () => ctx.open(app.id) }, 'Open'),
        // Edit is exposed only for user-created (local) web apps.
        app.local ? h('button.btn', { title: 'Edit', onclick: () => webAppDialog(app), html: icons.edit }) : null,
        app.system ? null : h('button.btn', { title: app.local ? 'Remove' : 'Uninstall', onclick: () => uninstall(app), html: icons.trash }),
      );
    }

    function card(app) {
      return h(`article.store-card${focusId === app.id ? '.highlight' : ''}`, { dataset: { id: app.id } },
        h('header', appIcon(app, 'md'), h('div', h('h4', app.name), h('small.muted', app.developer))),
        h('p', app.description),
        h('div.store-meta', h('span', app.category), app.local ? h('span.chip', 'Your web app') : h('span', `v${app.version}`), app.installed ? h('span.chip.accent', 'Installed') : null),
        actions(app),
      );
    }

    async function install(app) {
      installing.set(app.id, 0);
      draw();
      // Mounting is a single API call; a short progress animation gives feedback.
      for (let p = 0; p < 100; p += 20) {
        installing.set(app.id, p);
        refreshCard(app.id);
        await new Promise((r) => setTimeout(r, 60));
      }
      try {
        await registry.install(app.id);
        ctx.notify(`${app.name} installed`, 'Find it in Start, or drag it onto the taskbar or desktop.', { type: 'success' });
      } catch (e) {
        ctx.notify('Install failed', e.message, { type: 'error' });
      }
      installing.delete(app.id);
      draw();
    }

    // Install a catalog app through the single local-install path
    // (registry.installFromCatalog → validate → createLocal → localStorage).
    async function installCatalog(entry) {
      installing.set(entry.id, 0);
      draw();
      for (let p = 0; p < 100; p += 25) {
        installing.set(entry.id, p);
        draw();
        await new Promise((r) => setTimeout(r, 55));
      }
      try {
        const app = registry.installFromCatalog(entry.id);
        ctx.notify(`${app.name} installed`, 'Find it in Start, or drag it to the taskbar or desktop.', { type: 'success' });
      } catch (e) {
        ctx.notify('Install failed', e.message, { type: 'error' });
      }
      installing.delete(entry.id);
      draw();
    }

    async function uninstall(app) {
      // Match the existing confirm pattern used for destructive actions.
      if (app.local && !confirm(`Remove “${app.name}”? This deletes the app from this browser.`)) return;
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

    // Create (existing = null) or edit (existing = a local app) a web app.
    // The installer only builds/edits the manifest; the runtime layer decides
    // how each app launches. The id is never editable.
    function webAppDialog(existing = null) {
      const editing = !!existing;
      const name = h('input.field', { placeholder: 'e.g. Wikipedia', maxlength: 60, required: true, value: existing?.name || '' });
      const url = h('input.field', { type: 'url', placeholder: 'https://example.com/', required: true, value: existing?.target || '' });
      const rt = normalizeRuntime(existing?.runtime);
      const runtime = h('select.field',
        RUNTIME_DEFS.map((r) => h('option', { value: r.id, selected: rt === r.id }, r.label)));
      const icon = h('input.field', { type: 'url', placeholder: 'https://…/icon.png (optional)', value: existing?.iconUrl || '' });
      // Permission checkboxes — one per currently supported capability. An app
      // only receives a capability if its box is checked (stored in the manifest).
      const granted = new Set(existing?.permissions || []);
      const permBoxes = PERMISSIONS.map((p) => h('input', { type: 'checkbox', value: p, checked: granted.has(p) }));
      const perms = h('div.store-perms', PERMISSIONS.map((p, i) =>
        h('label.store-perm', permBoxes[i], h('span', PERMISSION_LABELS[p]))));
      const dialog = h('div.store-dialog-backdrop',
        h('form.store-dialog.glass',
          h('h2', editing ? 'Edit web app' : 'New web app'),
          h('label', h('span', 'Name'), name),
          h('label', h('span', 'Target URL'), url),
          h('label', h('span', 'Runtime'), runtime),
          h('label', h('span', 'Icon URL (optional)'), icon),
          h('label', h('span', 'Permissions'), perms),
          h('p.muted', { style: { margin: '0', fontSize: 'var(--fs-xs)' } }, 'Saved in this browser. Sites that block embedding won’t display in Direct mode — use External to open them in Orion.'),
          h('div.store-dialog-actions',
            h('button.btn', { type: 'button', onclick: () => dialog.remove() }, 'Cancel'),
            h('button.btn.primary', { type: 'submit' }, editing ? 'Save' : 'Create app')),
        ));
      dialog.querySelector('form').addEventListener('submit', (e) => {
        e.preventDefault();
        const permissions = permBoxes.filter((b) => b.checked).map((b) => b.value);
        const fields = { name: name.value, target: url.value, runtime: runtime.value, icon: icon.value, permissions };
        try {
          const app = editing ? registry.editLocal(existing.id, fields) : registry.createLocal(fields);
          dialog.remove();
          ctx.notify(editing ? `${app.name} updated` : `${app.name} added`,
            editing ? 'Changes saved.' : 'Find it in Start; drag it to the taskbar or desktop.', { type: 'success' });
          cat = 'Web';
          draw();
        } catch (err) {
          ctx.notify(editing ? 'Could not save changes' : 'Could not add app', err.message, { type: 'error' });
        }
      });
      root.querySelector('.app').append(dialog);
      setTimeout(() => name.focus(), 30);
    }
    const addWebApp = () => webAppDialog(null);

    function refreshCard(id) {
      const el = main.querySelector(`.store-card[data-id="${id}"]`);
      if (el) el.replaceWith(card(registry.get(id)));
    }

    // Catalog discovery controls (Home): category chips generated from catalog
    // data + a Clear action. The search box (query) is the toolbar field.
    function catalogControls(catalogAll) {
      const cats = [...new Set(catalogAll.map((e) => e.category).filter(Boolean))].sort();
      const chip = (id, label) => {
        const b = h(`button.store-cat${catCat === id ? '.active' : ''}`, label);
        b.addEventListener('click', () => { catCat = id; draw(); });
        return b;
      };
      const active = !!query || catCat !== 'all';
      return h('div.store-controls',
        h('div.store-cats', chip('all', 'All'), ...cats.map((c) => chip(c, c))),
        active ? h('button.btn.ghost.store-clear', { onclick: () => { catCat = 'all'; search.value = ''; query = ''; draw(); } }, 'Clear filters') : null,
      );
    }

    // Case-insensitive catalog match over name, description, publisher, category.
    function matchesCatalog(e) {
      if (catCat !== 'all' && e.category !== catCat) return false;
      if (!query) return true;
      return `${e.name} ${e.description || ''} ${e.publisher || ''} ${e.category || ''}`.toLowerCase().includes(query);
    }

    function renderHome(all) {
      const featured = registry.get('geforcenow') || all[0];
      const [a, b] = ['#1c3a05', '#0b1402'];
      const hero = h('section.store-hero', { style: { '--hero-a': a, '--hero-b': b } },
        appIcon(featured, 'xl'),
        h('div', h('small', { style: { textTransform: 'uppercase', letterSpacing: '.1em', opacity: 0.8 } }, 'Featured'),
          h('h2', featured.name), h('p', featured.description), actions(featured)),
      );
      hero.style.setProperty('--hero-a', a);
      hero.style.setProperty('--hero-b', b);

      // Catalog Available = catalog entries not installed (identity = catalog id,
      // so installed entries drop out — never mixed back into Available).
      const catalogAll = registry.catalog();
      const available = catalogAll.filter((e) => !e.installed).map((e) => ({ ...e, module: 'webapp', fromCatalog: true, developer: e.publisher }));
      const filtered = available.filter(matchesCatalog);
      let catalogBody;
      if (filtered.length) catalogBody = h('div.store-grid', filtered.map(card));
      else {
        const msg = available.length === 0 ? 'Everything in the catalog is installed.'
          : query ? `No catalog apps match “${query}”.`
          : `No catalog apps in “${catCat}”.`;
        catalogBody = h('div.empty', msg);
      }

      const web = all.filter((x) => x.custom);
      fill(main,
        hero,
        catalogAll.length ? h('div.section-title', 'Orion OS App Catalog', h('small.muted', ' · available to install')) : null,
        catalogAll.length ? catalogControls(catalogAll) : null,
        catalogAll.length ? catalogBody : null,
        h('div.section-title', 'Apps'), h('div.store-grid', all.filter((x) => !x.custom).map(card)),
        h('div.section-title', 'Your web apps'),
        web.length ? h('div.store-grid', web.map(card)) : h('div.card.muted', 'Turn any website into a desktop app with “Add web app”. It opens in its own window without browser controls and can be pinned to the taskbar. Sites that don’t allow embedding show an explanation instead.'),
      );
    }

    function draw() {
      nav.replaceChildren(...CATS.map((c) => {
        const b = h(`button.nav-item${cat === c.id ? '.active' : ''}`, { html: icons[c.icon] }, c.label);
        b.addEventListener('click', () => { cat = c.id; focusId = null; catCat = 'all'; search.value = query = ''; draw(); });
        return b;
      }));

      const all = registry.all();
      if (cat === 'home') {
        renderHome(all);
      } else if (query) {
        // Existing per-store search for the non-Home tabs.
        const hits = all.filter((a) => `${a.name} ${a.description} ${a.category} ${a.developer}`.toLowerCase().includes(query));
        main.replaceChildren(h('h1.page-title', `Results for “${query}”`), hits.length ? h('div.store-grid', hits.map(card)) : h('div.empty', 'Nothing found.'));
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
    if (ctx.args.addWebApp) setTimeout(addWebApp, 50);
    return {
      onArgs(a) {
        if (a.focus) { focusId = a.focus; cat = 'home'; draw(); }
        if (a.addWebApp) addWebApp();
      },
      destroy: off,
    };
  },
};
