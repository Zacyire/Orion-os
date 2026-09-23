// Orion — web browser.
//
// Each tab owns an AppFrame. Loading modes:
//   auto   — load directly; if /api/frame-check reports X-Frame-Options /
//            frame-ancestors, switch to the server proxy automatically.
//   direct — always a plain cross-origin iframe (full site capability).
//   proxy  — always through /proxy (sandboxed, opaque origin, no cookies).
// Proxied pages report navigation/titles via postMessage (see SHIM in
// src/handlers/proxy.rs); messages are only accepted from the tab's own frame.
import { h, local, fill } from '../core/dom.js';
import { icons } from '../core/icons.js';
import { createFrame, SANDBOX_WEB } from '../core/frame.js';

const SEARCH = 'https://html.duckduckgo.com/html/?q=';
const DEFAULT_DIAL = [
  { title: 'Wikipedia', url: 'https://en.wikipedia.org/' },
  { title: 'DuckDuckGo', url: 'https://html.duckduckgo.com/html/' },
  { title: 'Internet Archive', url: 'https://archive.org/' },
  { title: 'MDN Web Docs', url: 'https://developer.mozilla.org/' },
  { title: 'OpenStreetMap', url: 'https://www.openstreetmap.org/' },
  { title: 'Hacker News', url: 'https://news.ycombinator.com/' },
];
const MODES = { auto: 'Auto', direct: 'Direct', proxy: 'Proxy' };

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
const favicon = (u) => { try { return `https://icons.duckduckgo.com/ip3/${new URL(u).hostname}.ico`; } catch { return ''; } };

export default {
  mount(root, ctx) {
    let tabs = [];
    let active = null;
    let seq = 0;
    let mode = local.get('orion:mode', 'auto');
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
    const modeBtn = h('button.or-mode', { title: 'Loading mode: Auto → Direct → Proxy' });
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
          const useProxy = mode === 'proxy';
          tab.proxied = useProxy;
          tab.frame.load(u, { proxy: useProxy, check: mode === 'auto' });
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
        onBlocked: (url, info) => {
          // Auto mode: transparently retry through the proxy when allowed.
          if (mode === 'auto' && info.proxy_available) {
            tab.proxied = true;
            tab.frame.load(url, { proxy: true, check: false });
            sync();
          }
        },
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
      lock.title = !t?.url ? '' : t.proxied ? 'Loaded through the LTF proxy (sandboxed)' : secure ? 'Secure connection' : 'Not secure';
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
          h('p.or-dial-note', 'Mode ', h('b', MODES[mode]), ': sites that refuse to be embedded are loaded through the LTF proxy automatically. Proxied pages run sandboxed and cannot keep you signed in.'),
        ));
    }

    // ── toolbar actions ──
    back.addEventListener('click', () => { const t = active; if (t.index > 0) { t.index--; t.go(t.history[t.index], { push: false }); } });
    fwd.addEventListener('click', () => { const t = active; if (t.index < t.history.length - 1) { t.index++; t.go(t.history[t.index], { push: false }); } });
    reload.addEventListener('click', () => active?.url && active.go(active.url, { push: false }));
    homeBtn.addEventListener('click', () => active?.home());
    extBtn.addEventListener('click', () => active?.url && window.open(active.url, '_blank', 'noopener'));
    modeBtn.addEventListener('click', () => {
      mode = { auto: 'direct', direct: 'proxy', proxy: 'auto' }[mode];
      local.set('orion:mode', mode);
      ctx.notify(`Loading mode: ${MODES[mode]}`, { auto: 'Direct, with automatic proxy fallback.', direct: 'Always load sites directly.', proxy: 'Always load through the server proxy.' }[mode], { timeout: 2200 });
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

    // ── messages from proxied pages ──
    const onMessage = (e) => {
      const d = e.data;
      if (!d || d.source !== 'ltf-proxy') return;
      const tab = tabs.find((t) => t.frame?.iframe && e.source === t.frame.iframe.contentWindow);
      if (!tab) return;
      if (d.type === 'navigate' && typeof d.url === 'string' && d.url !== tab.url) {
        tab.history = tab.history.slice(0, tab.index + 1);
        tab.history.push(d.url);
        tab.index = tab.history.length - 1;
        tab.url = d.url;
        tab.title = hostOf(d.url);
      } else if (d.type === 'title' && typeof d.title === 'string' && d.title.trim()) {
        tab.title = d.title.trim().slice(0, 80);
      } else if (d.type === 'open' && /^https?:/.test(d.url)) {
        openTab(d.url, true);
      }
      if (tab === active) sync(); else renderTabs();
    };
    window.addEventListener('message', onMessage);

    openTab(ctx.args.url);
    return {
      onArgs(a) { if (a.url) openTab(a.url); },
      onFocus() { if (!active?.url) address.focus(); },
      destroy() {
        window.removeEventListener('message', onMessage);
        tabs.forEach((t) => t.frame?.destroy());
      },
    };
  },
};
