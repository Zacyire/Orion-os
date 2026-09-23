// Vapor — game store & library. Catalogue: content/games.json.
// Launch types: 'iframe' (own window via the embed host), 'proxy' (iframe via
// /proxy) and 'external' (new browser tab). Library ownership and play time
// are stored per device.
import { h, local, fill } from '../core/dom.js';
import { icons } from '../core/icons.js';
import { wm } from '../core/wm.js';

const fmtPlaytime = (ms) => {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${(m / 60).toFixed(1)} hrs`;
};

export default {
  single: true,

  async mount(root, ctx) {
    const doc = await ctx.api.content('games');
    const games = doc.items || [];
    const byId = new Map(games.map((g) => [g.id, g]));
    const library = new Set(local.get('vapor:library', []));
    const stats = local.get('vapor:stats', {}); // id → { playtime, last }
    const sessions = new Map(); // winId → { id, start }
    let tab = 'store';
    let tag = null;
    let query = '';
    let selected = null;

    const main = h('div.vp-main');
    const tabs = {};
    const tabBtn = (id, label) => (tabs[id] = h('button', { onclick: () => { tab = id; selected = null; render(); } }, label));
    const search = h('input.vp-search', { type: 'search', placeholder: 'Search the store', 'aria-label': 'Search games' });
    search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); tab = 'store'; selected = null; render(); });
    root.append(h('div.app.vapor',
      h('header.vp-top',
        h('div.vp-brand', h('span', { html: icons.gamepad }), 'VAPOR'),
        h('nav', tabBtn('store', 'Store'), tabBtn('library', 'Library')),
        h('span.spacer'),
        search,
      ),
      main,
    ));

    const saveLibrary = () => local.set('vapor:library', [...library]);
    const saveStats = () => local.set('vapor:stats', stats);
    const cover = (g) => h('div.vp-cover', { style: { backgroundImage: g.cover ? `url("${g.cover}")` : 'none' } }, g.cover ? null : h('span', g.title));

    async function launch(g) {
      const l = g.launch || {};
      if (!l.url) return ctx.notify('No launch URL', `${g.title} has no launch.url in content/games.json.`, { type: 'error' });
      if (!library.has(g.id)) { library.add(g.id); saveLibrary(); }
      stats[g.id] = { ...(stats[g.id] || { playtime: 0 }), last: Date.now() };
      saveStats();
      if (l.type === 'external') {
        window.open(l.url, '_blank', 'noopener');
        return render();
      }
      const win = await ctx.open('webplayer', {
        url: l.url, proxy: l.type === 'proxy', title: g.title, size: l.size, chrome: false,
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
        if (tab === 'library') render();
      }
    });

    function buttons(g) {
      const owned = library.has(g.id);
      return h('div.vp-buy',
        h('div.vp-price', g.price || 'Free'),
        owned
          ? h('button.vp-btn.play', { onclick: () => launch(g) }, h('span', { html: icons.play }), 'Play')
          : h('button.vp-btn.add', { onclick: () => { library.add(g.id); saveLibrary(); ctx.notify('Added to your library', g.title, { type: 'success' }); render(); } }, 'Add to Library'),
      );
    }

    function gamePage(g) {
      const s = stats[g.id];
      return h('div.vp-page',
        h('button.vp-back', { onclick: () => { selected = null; render(); }, html: icons.chevronLeft }, tab === 'library' ? 'Library' : 'Store'),
        h('h1', g.title),
        h('div.vp-page-grid',
          h('div', cover(g), h('div.vp-desc', h('h3', 'About this game'), h('p', g.description || ''), g.controls ? [h('h3', 'Controls'), h('p', g.controls)] : null)),
          h('aside',
            h('dl',
              h('dt', 'Developer'), h('dd', g.developer || '—'),
              h('dt', 'Released'), h('dd', g.released || '—'),
              h('dt', 'Genres'), h('dd', (g.genres || []).join(', ') || '—'),
              h('dt', 'Runs in'), h('dd', g.launch?.type === 'external' ? 'Browser tab' : 'LTF OS window'),
              s ? [h('dt', 'Play time'), h('dd', fmtPlaytime(s.playtime || 0))] : null,
            ),
            buttons(g),
          ),
        ),
      );
    }

    function store() {
      const tags = [...new Set(games.flatMap((g) => g.genres || []))];
      let list = games;
      if (tag) list = list.filter((g) => (g.genres || []).includes(tag));
      if (query) list = list.filter((g) => `${g.title} ${(g.genres || []).join(' ')} ${g.developer || ''}`.toLowerCase().includes(query));
      const feat = byId.get(doc.featured) || games[0];
      return h('div.vp-store',
        !query && feat ? h('section.vp-feature',
          h('div.vp-feature-art', cover(feat)),
          h('div.vp-feature-info',
            h('small', 'Featured & recommended'),
            h('h2', feat.title),
            h('p', feat.description),
            h('div.vp-tags', (feat.genres || []).map((t) => h('span', t))),
            h('div.vp-feature-actions', h('button.vp-btn', { onclick: () => { selected = feat.id; render(); } }, 'View'), buttons(feat)),
          )) : null,
        h('div.vp-filter',
          h('button', { class: tag ? '' : 'active', onclick: () => { tag = null; render(); } }, 'All'),
          tags.map((t) => h('button', { class: tag === t ? 'active' : '', onclick: () => { tag = t; render(); } }, t)),
        ),
        list.length ? h('div.vp-grid', list.map((g) => {
          const c = h('button.vp-card', cover(g), h('div.vp-card-body', h('b', g.title), h('small', (g.genres || []).join(' · ')), h('span.vp-card-price', library.has(g.id) ? 'In library' : g.price || 'Free')));
          c.addEventListener('click', () => { selected = g.id; render(); });
          return c;
        })) : h('div.vp-empty', games.length ? 'No games match.' : 'The store is empty. Add games to content/games.json.'),
      );
    }

    function libraryView() {
      const owned = games.filter((g) => library.has(g.id));
      if (!owned.length) return h('div.vp-empty', 'Your library is empty. Add games from the Store.');
      const current = byId.get(selected) && library.has(selected) ? byId.get(selected) : owned[0];
      const s = stats[current.id];
      return h('div.vp-lib',
        h('aside.vp-lib-list', owned.map((g) => {
          const b = h(`button${g.id === current.id ? '.active' : ''}`, h('span.vp-lib-thumb', { style: { backgroundImage: g.cover ? `url("${g.cover}")` : 'none' } }), g.title);
          b.addEventListener('click', () => { selected = g.id; render(); });
          return b;
        })),
        h('section.vp-lib-detail',
          h('div.vp-lib-hero', { style: { backgroundImage: current.cover ? `url("${current.cover}")` : 'none' } }),
          h('div.vp-lib-bar',
            h('button.vp-btn.play.big', { onclick: () => launch(current) }, h('span', { html: icons.play }), 'Play'),
            h('div', h('small', 'Last played'), h('b', s?.last ? new Date(s.last).toLocaleDateString() : 'Never')),
            h('div', h('small', 'Play time'), h('b', fmtPlaytime(s?.playtime || 0))),
            h('span.spacer'),
            h('button.vp-btn.ghost', { onclick: () => { library.delete(current.id); saveLibrary(); selected = null; render(); } }, 'Remove'),
          ),
          h('div.vp-lib-body', h('h2', current.title), h('p', current.description || ''), current.controls ? h('p.vp-controls', h('b', 'Controls: '), current.controls) : null),
        ),
      );
    }

    function render() {
      Object.entries(tabs).forEach(([id, b]) => b.classList.toggle('active', id === tab));
      if (selected && byId.has(selected) && tab === 'store') return fill(main, gamePage(byId.get(selected)));
      fill(main, tab === 'library' ? libraryView() : store());
    }

    render();
    return {
      onArgs(a) { if (a.game && byId.has(a.game)) { tab = 'store'; selected = a.game; render(); } },
      destroy: offWm,
    };
  },
};
