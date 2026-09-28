// YouTube — fallback experience for the YouTube web-app.
//
// The registry entry is a web-app targeting www.youtube.com, but youtube.com
// forbids embedding (X-Frame-Options), which Orion OS respects. apps/webapp.js
// therefore mounts this module as the app's sanctioned alternative: YouTube's
// official IFrame embed player (youtube-nocookie.com) plus the Data API.
// Home feed: content/youtube.json. Search: GET /api/youtube/search (needs
// YOUTUBE_API_KEY on the server). Pasting any YouTube link or video id plays
// it directly, with or without a key.
import { h, local, fill } from '../core/dom.js';
import { icons, appIcon } from '../core/icons.js';
import { createFrame } from '../core/frame.js';
import { netUrl } from '../core/api.js';

const ID_RE = /^[\w-]{11}$/;

/** Extract a video id from a URL (watch, youtu.be, shorts, embed) or a bare id. */
export function parseVideoId(input) {
  const s = input.trim();
  if (ID_RE.test(s)) return s;
  try {
    const u = new URL(s.startsWith('http') ? s : `https://${s}`);
    if (!/(^|\.)youtube(-nocookie)?\.com$|^youtu\.be$/.test(u.hostname)) return null;
    if (u.hostname === 'youtu.be') return ID_RE.test(u.pathname.slice(1)) ? u.pathname.slice(1) : null;
    const v = u.searchParams.get('v');
    if (v && ID_RE.test(v)) return v;
    const m = u.pathname.match(/\/(shorts|embed|live|v)\/([\w-]{11})/);
    return m ? m[2] : null;
  } catch {
    return null;
  }
}

// Thumbnails go through /net/ so the service worker caches them.
const thumbUrl = (v) => netUrl(v.thumbnail || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`);
// Hide the image (keeping the placeholder tile) if the thumbnail host is unreachable.
const thumbImg = (v) => h('img', { src: thumbUrl(v), alt: '', loading: 'lazy', onerror: (e) => (e.target.hidden = true) });
const embedUrl = (id) => `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&playsinline=1&modestbranding=1`;

export default {
  single: true,

  async mount(root, ctx) {
    const doc = await ctx.api.content('youtube');
    const info = await ctx.api.get('/system/info').catch(() => ({}));
    const canSearch = !!info.features?.youtube_search;
    const sections = doc.sections || [];
    let history = local.get('yt:history', []);
    let results = null; // { query, items, next }
    let frame = null;

    const input = h('input.yt-search-input', { type: 'search', placeholder: canSearch ? 'Search' : 'Paste a YouTube link or video ID', 'aria-label': 'Search' });
    const form = h('form.yt-search', input, h('button', { type: 'submit', html: icons.search, 'aria-label': 'Search' }));
    const main = h('div.yt-main');
    root.append(h('div.app.yt',
      h('header.yt-top',
        h('button.yt-logo', { onclick: () => home() }, appIcon(ctx.app, 'sm'), h('span', 'YouTube')),
        form,
        h('span.yt-top-spacer'),
      ),
      main,
    ));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const q = input.value.trim();
      if (!q) return home();
      const id = parseVideoId(q);
      if (id) return watch({ id, title: 'YouTube video', channel: '' });
      if (!canSearch) {
        return fill(main, h('div.yt-notice', h('span', { html: icons.info }),
          h('b', 'Search isn’t configured on this server'),
          h('p', 'Set YOUTUBE_API_KEY (YouTube Data API v3) on the Orion OS server to enable search. You can still paste any YouTube link or 11-character video ID.')));
      }
      fill(main, h('div.yt-loading', h('div.frame-spinner')));
      try {
        const r = await ctx.api.get(`/youtube/search?q=${encodeURIComponent(q)}`);
        results = { query: q, items: r.items, next: r.next };
        renderResults();
      } catch (err) {
        fill(main, h('div.yt-notice', h('span', { html: icons.info }), h('b', 'Search failed'), h('p', err.message)));
      }
    });

    function card(v, list) {
      const c = h('button.yt-card',
        h('div.yt-thumb', thumbImg(v), h('span.yt-thumb-play', { html: icons.play })),
        h('div.yt-card-meta', h('b', v.title), h('small', v.channel || '')),
      );
      c.addEventListener('click', () => watch(v, list));
      return c;
    }

    function home() {
      frame?.destroy();
      frame = null;
      input.value = '';
      ctx.win.setTitle('YouTube');
      const hist = history.slice(0, 8);
      fill(main, h('div.yt-feed',
        hist.length ? [h('h2', 'Recently watched'), h('div.yt-grid', hist.map((v) => card(v, hist)))] : null,
        sections.map((s) => [h('h2', s.title), h('div.yt-grid', (s.videos || []).map((v) => card(v, s.videos)))]),
        !sections.length && !hist.length ? h('div.yt-notice', h('span', { html: icons.play2 }), h('b', 'Nothing here yet'), h('p', 'Add sections of video ids to content/youtube.json, or paste a YouTube link above.')) : null,
      ));
      main.scrollTop = 0;
    }

    function renderResults() {
      fill(main, h('div.yt-feed', h('h2', `Results for “${results.query}”`),
        results.items.length ? h('div.yt-grid', results.items.map((v) => card(v, results.items))) : h('p', 'No results.')));
    }

    function watch(v, list = []) {
      history = [v, ...history.filter((x) => x.id !== v.id)].slice(0, 30);
      local.set('yt:history', history);
      frame?.destroy();
      // CREATOR SLOT: official YouTube embed player (privacy-enhanced domain)
      frame = createFrame({
        slot: 'youtube.player',
        title: v.title,
        url: embedUrl(v.id),
        allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen',
      });
      const upNext = list.filter((x) => x.id !== v.id);
      ctx.win.setTitle(`${v.title} — YouTube`);
      fill(main, h('div.yt-watch',
        h('div.yt-primary',
          h('div.yt-player', frame.el),
          h('h1', v.title),
          h('div.yt-watch-meta',
            h('div.yt-channel', h('span.yt-avatar', (v.channel || '?')[0]), h('b', v.channel || 'YouTube')),
            h('span.spacer'),
            h('button.yt-pill', { onclick: () => window.open(`https://www.youtube.com/watch?v=${v.id}`, '_blank', 'noopener') }, h('span', { html: icons.external }), 'Open on YouTube'),
            h('button.yt-pill', { onclick: () => navigator.clipboard?.writeText(`https://youtu.be/${v.id}`).then(() => ctx.notify('Link copied')) }, h('span', { html: icons.open }), 'Share'),
          ),
        ),
        upNext.length ? h('aside.yt-next', h('h3', 'Up next'), upNext.map((x) => {
          const b = h('button.yt-next-item', h('div.yt-thumb', thumbImg(x)), h('div', h('b', x.title), h('small', x.channel || '')));
          b.addEventListener('click', () => watch(x, list));
          return b;
        })) : null,
      ));
      main.scrollTop = 0;
    }

    home();
    return {
      onArgs(a) { if (a.video) watch({ id: a.video, title: a.title || 'YouTube video', channel: a.channel || '' }); },
      destroy() { frame?.destroy(); },
    };
  },
};
