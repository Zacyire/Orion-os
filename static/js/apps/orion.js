// Orion — the general-purpose browser ("type": "browser" in the registry).
//
// Orion is the only app with full navigation chrome (address bar, tabs,
// back/forward/reload, bookmarks). Each tab owns an AppFrame (core/frame.js),
// the same web container that web-apps use. Loading modes:
//   direct   — the site in a normal cross-origin iframe (its own cookies,
//              logins, DRM and security policies apply).
//   isolated — the page rendered via /proxy/page in an opaque-origin sandbox
//              (no cookies); navigation and titles are reported back so the
//              address bar and history stay in sync.
// Either way every URL is preflighted by /api/web/inspect; a site that
// forbids embedding shows EMBEDDING_NOT_ALLOWED with "Open in browser tab".
import { h, local, fill } from '../core/dom.js';
import { icons } from '../core/icons.js';
import { createFrame, SANDBOX_WEB } from '../core/frame.js';
import { netUrl } from '../core/api.js';

const SEARCH = 'https://html.duckduckgo.com/html/?q=';
const DEFAULT_DIAL = [
  { title: 'Wikipedia', url: 'https://en.wikipedia.org/' },
  { title: 'DuckDuckGo', url: 'https://html.duckduckgo.com/html/' },
  { title: 'Internet Archive', url: 'https://archive.org/' },
  { title: 'MDN Web Docs', url: 'https://developer.mozilla.org/' },
  { title: 'OpenStreetMap', url: 'https://www.openstreetmap.org/' },
  { title: 'Hacker News', url: 'https://news.ycombinator.com/' },
];
const MODES = { direct: 'Direct', isolated: 'Isolated' };
const MODE_HELP = {
  direct: 'Sites load normally in their own origin — sign-ins and media work.',
  isolated: 'Pages render through the LTF OS server in a sandbox without cookies; the address bar follows navigation.',
};

/** Turn address-bar input into a URL: explicit URL, bare domain, or search. */
export function toUrl(input) {
  const s = input.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(s) && !/\s/.test(s)) return `https://${s}`;
  if (/^localhost(:\d+)?(\/\S*)?$/.test(s)) return `http://${s}`;
  return SEARCH + encodeURIComponent(s);
}

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
// Favicons go through /net/ so the service worker can cache them.
const favicon = (u) => { try { return netUrl(`https://icons.duckduckgo.com/ip3/${new URL(u).hostname}.ico`); } catch { return ''; } };

export default {
  mount(root, ctx) {
    let tabs = [];
    let active = null;
    let seq = 0;
    let mode = { auto: 'direct', proxy: 'isolated' }[local.get('orion:mode')] || local.get('orion:mode', 'direct');
    if (!MODES[mode]) mode = 'direct';
    let bookmarks = local.get('orion:bookmarks', []);

    // ── chrome ──
    const tabStrip = h('div.or-tabs');
    const newTabBtn = h('button.or-newtab', { html: icons.plus, title: 'New tab', onclick: () => openTab() });
    const back = h('button.or-nav', { html: icons.arrowLeft, title: 'Back' });
    const fwd = h('button.or-nav', { html: icons.arrowRight, title: 'Forward' });
    const reload = h('button.or-nav', { html: icons.refresh, title: 'Reload' });
    const homeBtn = h('button.or-nav', { html: icons.home, title: 'New tab page' });
    const lock = h('span.or-lock');
    const address = h('input.or-address', { spellcheck: false, placeholder: 'Search or enter address', 'aria-label': 'Address' });
    const star = h('button.or-nav', { html: icons.star2, title: 'Bookmark this page' });
    const modeBtn = h('button.or-mode', { title: 'Loading mode: Direct ⇄ Isolated' });
    const extBtn = h('button.or-nav', { html: icons.external, title: 'Open in a real browser tab' });
    const content = h('div.or-content');
    root.append(h('div.app.orion',
      h('div.or-tabbar', tabStrip, newTabBtn),
      h('div.or-toolbar', back, fwd, reload, homeBtn,
        h('form.or-omnibox', { onsubmit: (e) => { e.preventDefault(); const u = toUrl(address.value); if (u) active.go(u); address.blur(); } }, lock, address, star),
        modeBtn, extBtn),
      content,
    ));
    address.addEventListener('focus', () => address.select());

    function renderModeBtn() {
      modeBtn.replaceChildren(h('span', { html: icons.shield }), MODES[mode]);
      modeBtn.dataset.mode = mode;
    }

    // ── tab model ──
    function openTab(url, focus = true) {
      const tab = {
        id: ++seq, url: null, title: 'New tab', proxied: false, history: [], index: -1,
        frame: null,
        dial: h('div.or-dial'),
        el: h('div.or-page'),
        chip: null,
        go(u, { push = true } = {}) {
          if (push) {
            tab.history = tab.history.slice(0, tab.index + 1);
            tab.history.push(u);
            tab.index = tab.history.length - 1;
          }
          tab.url = u;
          tab.title = hostOf(u);
          tab.dial.hidden = true;
          ensureFrame(tab);
          tab.proxied = mode === 'isolated';
          tab.frame.load(u, { isolated: tab.proxied });
          sync();
        },
        home() {
          tab.url = null;
          tab.title = 'New tab';
          tab.frame?.destroy();
          tab.frame = null;
          tab.dial.hidden = false;
          renderDial(tab);
          sync();
        },
      };
      tab.el.append(tab.dial);
      content.append(tab.el);
      tabs.push(tab);
      renderDial(tab);
      if (focus) select(tab);
      if (url) tab.go(url);
      renderTabs();
      return tab;
    }

    function ensureFrame(tab) {
      if (tab.frame) return;
      // CREATOR SLOT: browser viewport (one AppFrame per tab)
      tab.frame = createFrame({
        slot: `orion.tab.${tab.id}`,
        title: 'Web page',
        sandbox: SANDBOX_WEB,
        allow: 'autoplay; fullscreen; picture-in-picture; clipboard-write; encrypted-media; geolocation',
        onLoad: (cur) => { tab.proxied = cur.isolated; if (tab === active) sync(); },
        onError: () => { if (tab === active) sync(); },
        // Isolated pages report in-page navigation → keep address bar & history in sync.
        onNavigate: (url) => {
          if (url === tab.url) return;
          tab.history = tab.history.slice(0, tab.index + 1);
          tab.history.push(url);
          tab.index = tab.history.length - 1;
          tab.url = url;
          tab.title = hostOf(url);
          if (tab === active) sync(); else renderTabs();
        },
        onTitle: (t) => { if (t) { tab.title = t.slice(0, 80); if (tab === active) sync(); else renderTabs(); } },
        onOpen: (url) => openTab(url, true),
      });
      tab.el.append(tab.frame.el);
    }

    function select(tab) {
      active = tab;
      tabs.forEach((t) => (t.el.hidden = t !== tab));
      sync();
      if (!tab.url) setTimeout(() => address.focus(), 30);
    }

    function closeTab(tab) {
      tab.frame?.destroy();
      tab.el.remove();
      const i = tabs.indexOf(tab);
      tabs = tabs.filter((t) => t !== tab);
      if (!tabs.length) return ctx.win.close();
      if (active === tab) select(tabs[Math.min(i, tabs.length - 1)]);
      renderTabs();
    }

    function renderTabs() {
      tabStrip.replaceChildren(...tabs.map((t) => {
        const chip = h(`div.or-tab${t === active ? '.active' : ''}`, { title: t.url || 'New tab' },
          t.url ? h('img.or-fav', { src: favicon(t.url), alt: '', onerror: (e) => e.target.replaceWith(h('span.or-fav', { html: icons.globe })) }) : h('span.or-fav', { html: icons.tab }),
          h('span.or-tab-title', t.title),
          h('button.or-tab-close', { html: icons.close, title: 'Close tab', onclick: (e) => { e.stopPropagation(); closeTab(t); } }),
        );
        chip.addEventListener('click', () => select(t));
        chip.addEventListener('auxclick', (e) => { if (e.button === 1) closeTab(t); });
        t.chip = chip;
        return chip;
      }));
    }

    function sync() {
      const t = active;
      if (document.activeElement !== address) address.value = t?.url || '';
      back.disabled = !t || t.index <= 0;
      fwd.disabled = !t || t.index >= t.history.length - 1;
      reload.disabled = !t?.url;
      extBtn.disabled = !t?.url;
      star.classList.toggle('on', !!t?.url && bookmarks.some((b) => b.url === t.url));
      const secure = t?.url?.startsWith('https:');
      lock.innerHTML = t?.url ? (t.proxied ? icons.shield : secure ? icons.lock : icons.info) : icons.search;
      lock.title = !t?.url ? '' : t.proxied ? 'Isolated: rendered by the LTF OS server in a sandbox' : secure ? 'Secure connection' : 'Not secure';
      lock.dataset.state = t?.proxied ? 'proxy' : secure ? 'secure' : 'plain';
      ctx.win.setTitle(t?.url ? `${t.title} — Orion` : 'Orion');
      renderTabs();
      renderModeBtn();
    }

    function renderDial(tab) {
      const q = h('input.or-dial-search', { placeholder: 'Search the web', spellcheck: false });
      const dial = [...bookmarks, ...DEFAULT_DIAL.filter((d) => !bookmarks.some((b) => b.url === d.url))].slice(0, 12);
      fill(tab.dial,
        h('div.or-dial-inner',
          h('div.or-dial-logo', h('span', { html: icons.globe }), 'Orion'),
          h('form', { onsubmit: (e) => { e.preventDefault(); const u = toUrl(q.value); if (u) tab.go(u); } }, q),
          h('div.or-dial-grid', dial.map((d) => h('button.or-dial-item', { onclick: () => tab.go(d.url), title: d.url },
            h('span.or-dial-icon', h('img', { src: favicon(d.url), alt: '', onerror: (e) => e.target.replaceWith(h('span', { html: icons.globe })) })),
            h('span', d.title)))),
          h('p.or-dial-note', h('b', `${MODES[mode]} mode. `), MODE_HELP[mode], ' Sites that don’t allow embedding can be opened in a normal browser tab.'),
        ));
    }

    // ── toolbar actions ──
    back.addEventListener('click', () => { const t = active; if (t.index > 0) { t.index--; t.go(t.history[t.index], { push: false }); } });
    fwd.addEventListener('click', () => { const t = active; if (t.index < t.history.length - 1) { t.index++; t.go(t.history[t.index], { push: false }); } });
    reload.addEventListener('click', () => active?.url && active.go(active.url, { push: false }));
    homeBtn.addEventListener('click', () => active?.home());
    extBtn.addEventListener('click', () => active?.url && window.open(active.url, '_blank', 'noopener'));
    modeBtn.addEventListener('click', () => {
      mode = mode === 'direct' ? 'isolated' : 'direct';
      local.set('orion:mode', mode);
      ctx.notify(`${MODES[mode]} mode`, MODE_HELP[mode], { timeout: 2600 });
      if (active?.url) active.go(active.url, { push: false });
      else renderDial(active);
      renderModeBtn();
    });
    star.addEventListener('click', () => {
      const t = active;
      if (!t?.url) return;
      const i = bookmarks.findIndex((b) => b.url === t.url);
      if (i >= 0) bookmarks.splice(i, 1);
      else bookmarks.unshift({ title: t.title, url: t.url });
      local.set('orion:bookmarks', bookmarks);
      sync();
    });

    openTab(ctx.args.url);
    return {
      onArgs(a) { if (a.url) openTab(a.url); },
      onFocus() { if (!active?.url) address.focus(); },
      destroy() {
        tabs.forEach((t) => t.frame?.destroy());
      },
    };
  },
};
