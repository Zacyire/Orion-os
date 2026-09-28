// Vapor — Orion's gaming hub.
//
//   Home  ─┬─ Local Gaming : Recently Played · Installed · Available ·
//          │                 Favorites · Categories (+ search, game pages)
//          └─ Cloud Gaming : cloud gaming services, as launcher entries
//
// Data (unchanged sources of truth, per device):
//   content/games.json (/api/content/games, or the static copy) — the catalogue
//   vapor:library   installed (added-to-library) game ids
//   vapor:stats     id → { playtime, last }   (real play sessions only)
//   vapor:favorites favourite game ids (new; display-only, grants nothing)
//
// Local launch types: 'iframe' (own window via the web-app container),
// 'isolated' (through /proxy/page — only when the server's web layer is
// enabled) and 'external' (new browser tab).
//
// Cloud entries in games.json name REGISTRY APPS ({ "app": "roblox" }), never
// URLs: Vapor only launches apps Orion already knows, through the normal app
// runtime (which opens external services in the user's browser). Nothing here
// streams, hosts or routes a cloud service.

import { h, local, fill } from '../core/dom.js';
import { icons, appIcon } from '../core/icons.js';
import { wm } from '../core/wm.js';
import { registry } from '../core/registry.js';

const fmtPlaytime = (ms) => {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${(m / 60).toFixed(1)} hrs`;
};

const LOCAL_SECTIONS = [
  ['recent', 'Recently Played', 'clock'],
  ['installed', 'Installed', 'library'],
  ['available', 'Available', 'store'],
  ['favorites', 'Favorites', 'star'],
  ['categories', 'Categories', 'grid'],
];

export default {
  single: true,

  async mount(root, ctx) {
    const doc = await ctx.api.content('games');
    const games = Array.isArray(doc.items) ? doc.items : [];
    const byId = new Map(games.map((g) => [g.id, g]));
    // Cloud services: only ids of apps in the registry; anything else is dropped.
    const cloudIds = (Array.isArray(doc.cloud) ? doc.cloud : [])
      .map((c) => (typeof c?.app === 'string' ? c.app : null))
      .filter((id) => id && registry.get(id) && !registry.get(id).local); // built-in apps only
    const library = new Set(local.get('vapor:library', []));
    const stats = local.get('vapor:stats', {}); // id → { playtime, last }
    const favorites = new Set(local.get('vapor:favorites', []).filter((id) => typeof id === 'string'));
    const sessions = new Map(); // winId → { id, start }

    let view = 'home';          // 'home' | 'local' | 'cloud'
    let section = 'recent';     // local section
    let tag = null;             // category filter
    let query = '';
    let selected = null;        // game page

    const main = h('div.vp-main');
    const tabs = {};
    const go = (v, s) => { view = v; if (s) section = s; selected = null; render(); };
    const tabBtn = (id, label) => (tabs[id] = h('button', { onclick: () => go(id) }, label));
    const search = h('input.vp-search', { type: 'search', placeholder: 'Search games', 'aria-label': 'Search games' });
    search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); view = 'local'; selected = null; render(); });
    root.append(h('div.app.vapor',
      h('header.vp-top',
        h('button.vp-brand', { onclick: () => go('home'), 'aria-label': 'Vapor home' }, h('span', { html: icons.gamepad }), 'VAPOR'),
        h('nav', tabBtn('home', 'Home'), tabBtn('local', 'Local Gaming'), tabBtn('cloud', 'Cloud Gaming')),
        h('span.spacer'),
        search,
      ),
      main,
    ));

    const saveLibrary = () => local.set('vapor:library', [...library]);
    const saveStats = () => local.set('vapor:stats', stats);
    const saveFavorites = () => local.set('vapor:favorites', [...favorites]);
    const cover = (g) => h('div.vp-cover', { style: { backgroundImage: g.cover ? `url("${g.cover}")` : 'none' } }, g.cover ? null : h('span', g.title));
    const recent = () => games.filter((g) => stats[g.id]?.last).sort((a, b) => stats[b.id].last - stats[a.id].last);

    async function launch(g) {
      const l = g.launch || {};
      if (!l.url) return ctx.notify('No launch URL', `${g.title} has no launch.url in content/games.json.`, { type: 'error' });
      if (!library.has(g.id)) { library.add(g.id); saveLibrary(); }
      stats[g.id] = { ...(stats[g.id] || { playtime: 0 }), last: Date.now() };
      saveStats();
      if (l.type === 'external') {
        window.open(l.url, '_blank', 'noopener,noreferrer');
        return render();
      }
      // Games open in the hidden "webplayer" web-app (apps/webapp.js), one window each.
      const win = await ctx.open('webplayer', {
        url: l.url, proxy: l.type === 'isolated' || l.type === 'proxy', title: g.title, size: l.size,
        allow: 'autoplay; fullscreen; gamepad',
      });
      if (win) sessions.set(win.id, { id: g.id, start: Date.now() });
      render();
    }

    // Accumulate play time when a game window closes.
    const offWm = ctx.bus.on('wm:changed', () => {
      for (const [winId, s] of sessions) {
        if (wm.windows.has(winId)) continue;
        sessions.delete(winId);
        stats[s.id] = { ...(stats[s.id] || {}), playtime: (stats[s.id]?.playtime || 0) + (Date.now() - s.start), last: Date.now() };
        saveStats();
        if (view === 'local') render();
      }
    });

    function favButton(g) {
      const on = favorites.has(g.id);
      return h(`button.vp-fav${on ? '.on' : ''}`, {
        'aria-pressed': String(on), title: on ? 'Remove from favorites' : 'Add to favorites', html: icons.star,
        onclick: (e) => { e.stopPropagation(); on ? favorites.delete(g.id) : favorites.add(g.id); saveFavorites(); render(); },
      });
    }

    function buttons(g) {
      const owned = library.has(g.id);
      return h('div.vp-buy',
        h('div.vp-price', g.price || 'Free'),
        owned
          ? h('button.vp-btn.play', { onclick: () => launch(g) }, h('span', { html: icons.play }), 'Play')
          : h('button.vp-btn.add', { onclick: () => { library.add(g.id); saveLibrary(); ctx.notify('Added to your library', g.title, { type: 'success' }); render(); } }, 'Add to Library'),
      );
    }

    function card(g) {
      const c = h('div.vp-card', { tabindex: 0, role: 'button', 'aria-label': g.title },
        cover(g),
        favButton(g),
        h('div.vp-card-body', h('b', g.title), h('small', (g.genres || []).join(' · ')),
          h('span.vp-card-price', library.has(g.id) ? 'Installed' : g.price || 'Free')),
      );
      const open = () => { selected = g.id; render(); };
      c.addEventListener('click', open);
      c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      return c;
    }
    const grid = (list, empty) => (list.length ? h('div.vp-grid', list.map(card)) : h('div.vp-empty', empty));

    function gamePage(g) {
      const s = stats[g.id];
      return h('div.vp-page',
        h('button.vp-back', { onclick: () => { selected = null; render(); }, html: icons.chevronLeft }, 'Back'),
        h('div.vp-page-title', h('h1', g.title), favButton(g)),
        h('div.vp-page-grid',
          h('div', cover(g), h('div.vp-desc', h('h3', 'About this game'), h('p', g.description || ''), g.controls ? [h('h3', 'Controls'), h('p', g.controls)] : null)),
          h('aside',
            h('dl',
              h('dt', 'Developer'), h('dd', g.developer || '—'),
              h('dt', 'Released'), h('dd', g.released || '—'),
              h('dt', 'Genres'), h('dd', (g.genres || []).join(', ') || '—'),
              h('dt', 'Runs in'), h('dd', g.launch?.type === 'external' ? 'Browser tab' : 'Orion OS window'),
              s ? [h('dt', 'Play time'), h('dd', fmtPlaytime(s.playtime || 0))] : null,
              s?.last ? [h('dt', 'Last played'), h('dd', new Date(s.last).toLocaleDateString())] : null,
            ),
            buttons(g),
          ),
        ),
      );
    }

    // ── Home: choose how to play ──
    function home() {
      const installed = games.filter((g) => library.has(g.id));
      const last = recent()[0];
      const localCard = h('button.vp-mode.vp-mode-local', { onclick: () => go('local', last ? 'recent' : 'installed') },
        h('span.vp-mode-ico', { html: icons.gamepad }),
        h('small', 'Play on this device'),
        h('h2', 'Local Gaming'),
        h('p', installed.length ? `${installed.length} installed · ${games.length} in the catalogue` : `${games.length} games in the catalogue`),
        last ? h('span.vp-mode-cta', 'Continue ', h('b', last.title)) : h('span.vp-mode-cta', 'Browse your library'),
      );
      const cloudCard = h('button.vp-mode.vp-mode-cloud', { onclick: () => go('cloud') },
        h('span.vp-mode-ico', { html: icons.cloudPlain }),
        h('small', 'Streamed by external services'),
        h('h2', 'Cloud Gaming'),
        h('p', cloudIds.length ? `${cloudIds.length} service${cloudIds.length === 1 ? '' : 's'} · opened by their providers` : 'No cloud services configured yet'),
        h('span.vp-mode-cta', 'Choose a service'),
      );
      return h('div.vp-home',
        h('div.vp-home-head', h('h1', 'Choose how you want to play'), h('p', 'Your games on this device, or cloud services that run on their providers’ servers.')),
        h('div.vp-modes', localCard, cloudCard),
      );
    }

    // ── Local Gaming ──
    function localView() {
      const nav = h('aside.vp-side', LOCAL_SECTIONS.map(([id, label, icon]) => {
        const count = id === 'installed' ? library.size : id === 'favorites' ? favorites.size : id === 'recent' ? recent().length : null;
        return h(`button${section === id && !query ? '.active' : ''}`, { onclick: () => { query = ''; search.value = ''; go('local', id); } },
          h('span', { html: icons[icon] }), label, count != null ? h('em', String(count)) : null);
      }));
      let body;
      if (query) {
        const list = games.filter((g) => `${g.title} ${(g.genres || []).join(' ')} ${g.developer || ''}`.toLowerCase().includes(query));
        body = [h('h2.vp-section-title', `Results for “${search.value.trim()}”`), grid(list, 'No games match.')];
      } else if (section === 'recent') {
        body = [h('h2.vp-section-title', 'Recently Played'), grid(recent(), 'Nothing played yet. Games you launch appear here.')];
      } else if (section === 'installed') {
        body = [h('h2.vp-section-title', 'Installed'), libraryView()];
      } else if (section === 'available') {
        body = [h('h2.vp-section-title', 'Available'), grid(games.filter((g) => !library.has(g.id)), games.length ? 'Everything in the catalogue is installed.' : 'The catalogue is empty.')];
      } else if (section === 'favorites') {
        body = [h('h2.vp-section-title', 'Favorites'), grid(games.filter((g) => favorites.has(g.id)), 'No favorites yet. Tap ☆ on a game to add it.')];
      } else {
        const tags = [...new Set(games.flatMap((g) => g.genres || []))].sort();
        const list = tag ? games.filter((g) => (g.genres || []).includes(tag)) : games;
        body = [
          h('h2.vp-section-title', 'Categories'),
          h('div.vp-filter',
            h('button', { class: tag ? '' : 'active', onclick: () => { tag = null; render(); } }, 'All'),
            tags.map((t) => h('button', { class: tag === t ? 'active' : '', onclick: () => { tag = t; render(); } }, t)),
          ),
          grid(list, 'No games in this category.'),
        ];
      }
      return h('div.vp-local', nav, h('section.vp-content', body));
    }

    function libraryView() {
      const owned = games.filter((g) => library.has(g.id));
      if (!owned.length) return h('div.vp-empty', 'Nothing installed yet. Add games from Available.');
      const current = byId.get(selected) && library.has(selected) ? byId.get(selected) : owned[0];
      const s = stats[current.id];
      return h('div.vp-lib',
        h('aside.vp-lib-list', owned.map((g) => {
          const b = h(`button${g.id === current.id ? '.active' : ''}`, h('span.vp-lib-thumb', { style: { backgroundImage: g.cover ? `url("${g.cover}")` : 'none' } }), g.title);
          b.addEventListener('click', () => { selected = g.id; renderInstalled(); });
          return b;
        })),
        h('section.vp-lib-detail',
          h('div.vp-lib-hero', { style: { backgroundImage: current.cover ? `url("${current.cover}")` : 'none' } }),
          h('div.vp-lib-bar',
            h('button.vp-btn.play.big', { onclick: () => launch(current) }, h('span', { html: icons.play }), 'Play'),
            h('div', h('small', 'Last played'), h('b', s?.last ? new Date(s.last).toLocaleDateString() : 'Never')),
            h('div', h('small', 'Play time'), h('b', fmtPlaytime(s?.playtime || 0))),
            h('span.spacer'),
            favButton(current),
            h('button.vp-btn.ghost', { onclick: () => { library.delete(current.id); saveLibrary(); selected = null; render(); } }, 'Remove'),
          ),
          h('div.vp-lib-body', h('h2', current.title), h('p', current.description || ''), current.controls ? h('p.vp-controls', h('b', 'Controls: '), current.controls) : null),
        ),
      );
    }
    // Installed keeps its own selection instead of opening the store page.
    function renderInstalled() { fill(main, localView()); }

    // ── Cloud Gaming ──
    function cloudView() {
      const cards = cloudIds.map((id) => {
        const app = registry.get(id);
        const external = app.runtime === 'external';
        return h('div.vp-cloud-card',
          appIcon(app, 'lg'),
          h('div.vp-cloud-info',
            h('h3', app.name),
            h('p', app.description || ''),
            h('small', external ? 'Opens in your browser · run by its provider, not by Orion' : 'Opens in an Orion window · run by its provider'),
          ),
          h('button.vp-btn.play', { onclick: () => ctx.open(id) }, h('span', { html: external ? icons.external : icons.play }), 'Launch'),
        );
      });
      return h('div.vp-cloud',
        h('div.vp-home-head', h('h1', 'Cloud Gaming'), h('p', 'These services stream games from their own servers. Orion launches them; it doesn’t host, stream or route them, and your browser’s normal settings and network rules apply.')),
        cards.length ? h('div.vp-cloud-list', cards) : h('div.vp-empty', 'No cloud gaming services are configured yet.'),
        h('p.vp-cloud-note', 'More services will be added once their official addresses and embedding rules are verified.'),
      );
    }

    function render() {
      Object.entries(tabs).forEach(([id, b]) => b.classList.toggle('active', id === view));
      if (selected && byId.has(selected) && view === 'local' && section !== 'installed') return fill(main, gamePage(byId.get(selected)));
      fill(main, view === 'local' ? localView() : view === 'cloud' ? cloudView() : home());
    }

    render();
    return {
      onArgs(a) { if (a.game && byId.has(a.game)) { view = 'local'; section = 'available'; selected = a.game; render(); } },
      destroy: offWm,
    };
  },
};
