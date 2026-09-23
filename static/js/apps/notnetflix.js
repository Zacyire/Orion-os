// NotNetflix — streaming front-end. Catalogue: content/movies.json
// (GET /api/content/movies). Each title's `source` is played by
// lib/videoplayer.js: direct video, HLS, or an embed URL in an AppFrame.
import { h, local, fill } from '../core/dom.js';
import { icons } from '../core/icons.js';
import { createVideoPlayer } from '../lib/videoplayer.js';

const RED = '#e50914';

export default {
  single: true,

  async mount(root, ctx) {
    const doc = await ctx.api.content('movies');
    const items = doc.items || [];
    const byId = new Map(items.map((m) => [m.id, m]));
    let myList = new Set(local.get('nnf:list', []));
    const progress = local.get('nnf:progress', {}); // id → { t, d, at }
    let player = null;
    let query = '';

    const main = h('div.nnf-main');
    const search = h('input.nnf-search', { type: 'search', placeholder: 'Titles, genres', 'aria-label': 'Search titles' });
    const navBtns = {};
    const nav = (id, label) => (navBtns[id] = h('button', { onclick: () => { query = ''; search.value = ''; view(id); } }, label));
    const shell = h('div.nnf',
      h('header.nnf-top',
        h('div.nnf-logo', 'NOTNETFLIX'),
        h('nav', nav('home', 'Home'), nav('movies', 'Movies'), nav('shorts', 'Shorts'), nav('list', 'My List')),
        h('span.spacer'),
        h('label.nnf-search-wrap', h('span', { html: icons.search }), search),
      ),
      main,
    );
    root.append(h('div.app', shell));
    search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); view(query ? 'search' : 'home'); });

    const saveList = () => local.set('nnf:list', [...myList]);
    const art = (m, kind = 'backdrop') => m[kind] || m.backdrop || m.poster || '';

    function card(m) {
      const p = progress[m.id];
      const pct = p && p.d ? Math.min(100, (p.t / p.d) * 100) : 0;
      const img = h('div.nnf-card-art', { style: { backgroundImage: art(m) ? `url("${art(m)}")` : 'none' } },
        art(m) ? null : h('span', m.title));
      const c = h('button.nnf-card', { title: m.title },
        img,
        pct > 1 && pct < 98 ? h('div.nnf-card-progress', h('i', { style: { width: `${pct}%` } })) : null,
        h('div.nnf-card-meta', h('b', m.title), h('small', [m.year, m.rating, m.duration].filter(Boolean).join(' · '))),
      );
      c.addEventListener('click', () => details(m));
      return c;
    }

    function row(title, list) {
      if (!list.length) return null;
      const track = h('div.nnf-row-track', list.map(card));
      const scroll = (dir) => track.scrollBy({ left: dir * track.clientWidth * 0.85, behavior: 'smooth' });
      return h('section.nnf-row',
        h('h3', title),
        h('div.nnf-row-wrap',
          h('button.nnf-row-nav.prev', { html: icons.chevronLeft, onclick: () => scroll(-1), 'aria-label': 'Scroll left' }),
          track,
          h('button.nnf-row-nav.next', { html: icons.chevronRight, onclick: () => scroll(1), 'aria-label': 'Scroll right' }),
        ));
    }

    function hero(m) {
      if (!m) return null;
      const inList = myList.has(m.id);
      return h('section.nnf-hero', { style: { backgroundImage: art(m) ? `url("${art(m)}")` : 'none' } },
        h('div.nnf-hero-body',
          h('h1', m.title),
          h('div.nnf-meta', h('span.nnf-match', 'Featured'), m.year, h('span.nnf-badge', m.rating || 'NR'), m.duration),
          h('p', m.description),
          h('div.nnf-actions',
            h('button.nnf-btn.play', { onclick: () => play(m) }, h('span', { html: icons.play }), progress[m.id]?.t > 5 ? 'Resume' : 'Play'),
            h('button.nnf-btn', { onclick: () => details(m) }, h('span', { html: icons.info }), 'More info'),
            h('button.nnf-btn.round', { title: inList ? 'Remove from My List' : 'Add to My List', html: inList ? icons.check : icons.plus, onclick: () => { toggleList(m); view('home'); } }),
          ),
        ));
    }

    function toggleList(m) {
      myList.has(m.id) ? myList.delete(m.id) : myList.add(m.id);
      saveList();
    }

    function empty(text) {
      return h('div.nnf-empty', h('span', { html: icons.play2 }), h('p', text));
    }

    function view(name) {
      Object.entries(navBtns).forEach(([id, b]) => b.classList.toggle('active', id === name));
      if (!items.length) {
        return fill(main, empty('No titles yet. Add entries to content/movies.json — each needs an id, title and a source { type, src }.'));
      }
      if (name === 'search') {
        const hits = items.filter((m) => `${m.title} ${(m.genres || []).join(' ')} ${m.description || ''}`.toLowerCase().includes(query));
        return fill(main, h('div.nnf-grid-wrap', h('h3', `Results for “${query}”`), hits.length ? h('div.nnf-grid', hits.map(card)) : empty('No matching titles.')));
      }
      if (name === 'list') {
        const mine = [...myList].map((id) => byId.get(id)).filter(Boolean);
        return fill(main, h('div.nnf-grid-wrap', h('h3', 'My List'), mine.length ? h('div.nnf-grid', mine.map(card)) : empty('Titles you add to My List appear here.')));
      }
      if (name === 'movies' || name === 'shorts') {
        const shorts = (m) => (m.genres || []).includes('Short');
        const list = items.filter((m) => (name === 'shorts' ? shorts(m) : !shorts(m)));
        return fill(main, h('div.nnf-grid-wrap', h('h3', name === 'shorts' ? 'Shorts' : 'Movies'), h('div.nnf-grid', list.map(card))));
      }
      const continuing = Object.entries(progress)
        .filter(([id, p]) => byId.has(id) && p.d && p.t / p.d > 0.02 && p.t / p.d < 0.97)
        .sort((a, b) => b[1].at - a[1].at)
        .map(([id]) => byId.get(id));
      const listed = new Set();
      const rows = (doc.rows || []).map((r) => {
        const list = (r.ids || []).map((id) => byId.get(id)).filter(Boolean);
        list.forEach((m) => listed.add(m.id));
        return row(r.title, list);
      });
      const genres = [...new Set(items.flatMap((m) => m.genres || []))];
      fill(main,
        hero(byId.get(doc.featured) || items[0]),
        row('Continue Watching', continuing),
        row('My List', [...myList].map((id) => byId.get(id)).filter(Boolean)),
        rows,
        genres.map((g) => row(g, items.filter((m) => (m.genres || []).includes(g)))),
        row('All titles', items),
      );
      main.scrollTop = 0;
    }

    function details(m) {
      const inList = myList.has(m.id);
      const modal = h('div.nnf-modal-backdrop',
        h('div.nnf-modal',
          h('div.nnf-modal-art', { style: { backgroundImage: art(m) ? `url("${art(m)}")` : 'none' } },
            h('button.nnf-modal-close', { html: icons.close, 'aria-label': 'Close', onclick: () => modal.remove() }),
            h('div.nnf-modal-title', h('h2', m.title),
              h('div.nnf-actions',
                h('button.nnf-btn.play', { onclick: () => { modal.remove(); play(m); } }, h('span', { html: icons.play }), progress[m.id]?.t > 5 ? 'Resume' : 'Play'),
                h('button.nnf-btn.round', { html: inList ? icons.check : icons.plus, title: 'My List', onclick: () => { toggleList(m); modal.remove(); details(m); view('home'); } }),
              )),
          ),
          h('div.nnf-modal-body',
            h('div',
              h('div.nnf-meta', m.year, h('span.nnf-badge', m.rating || 'NR'), m.duration),
              h('p', m.description || ''),
            ),
            h('dl',
              h('dt', 'Genres'), h('dd', (m.genres || []).join(', ') || '—'),
              m.credits ? [h('dt', 'Credits'), h('dd', m.credits)] : null,
              h('dt', 'Source'), h('dd', m.source?.type || '—'),
            ),
          ),
        ));
      modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
      shell.append(modal);
    }

    function play(m) {
      player?.destroy();
      ctx.win.setTitle(`${m.title} — NotNetflix`);
      player = createVideoPlayer({
        source: m.source,
        title: m.title,
        poster: art(m),
        accent: RED,
        startAt: progress[m.id]?.t || 0,
        onProgress: (t, d) => { progress[m.id] = { t, d, at: Date.now() }; local.set('nnf:progress', progress); },
        onClose: closePlayer,
        onEnded: closePlayer,
      });
      player.el.classList.add('nnf-player');
      shell.append(player.el);
      player.focus();
    }

    function closePlayer() {
      player?.destroy();
      player = null;
      ctx.win.setTitle('NotNetflix');
      view('home');
    }

    view('home');
    return {
      onArgs(a) { if (a.play && byId.has(a.play)) play(byId.get(a.play)); },
      destroy() { player?.destroy(); },
    };
  },
};
