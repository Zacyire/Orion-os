// AppFrame — the web container shared by every web-app window and every
// Orion tab. One implementation, different amounts of chrome around it.
//
// Request lifecycle (see also src/web/mod.rs):
//
//   frame.load(url)
//     │
//     ├─ relative URL (first-party content, e.g. static/games) ─→ iframe, no preflight
//     │
//     ├─ api.inspect(url)  →  GET /api/web/inspect   (validation, SSRF guard,
//     │                                               redirects, framing policy)
//     │     ├─ error code ──────────────→ native error screen (INVALID_URL, BLOCKED_REQUEST,
//     │     │                              SITE_UNAVAILABLE, NETWORK_TIMEOUT, …)
//     │     ├─ embeddable: false ───────→ EMBEDDING_NOT_ALLOWED (+ "Open in browser tab");
//     │     │                              the site's policy is respected, never bypassed
//     │     └─ ok
//     │
//     ├─ mode "direct"   → <iframe src="https://site/…">   real origin: the site's own
//     │                     cookies, CSP and DRM apply; LTF OS never sees the traffic
//     └─ mode "isolated" → <iframe src="/proxy/page?url=…"> opaque-origin sandbox;
//                           navigation/title reported back via postMessage
//
//   const frame = createFrame({ slot: 'netflix.main', title: 'Netflix', onError, onNavigate });
//   body.append(frame.el);
//   frame.load('https://example.com/', { isolated: false });

import { h } from './dom.js';
import { icons } from './icons.js';
import { api, pageUrl } from './api.js';

/** Remote site loaded directly: its own origin, but it can't navigate the OS (no allow-top-navigation). */
export const SANDBOX_WEB = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation allow-modals allow-pointer-lock allow-orientation-lock';
/** Isolated (/proxy/page) documents: opaque origin — must never include allow-same-origin. */
export const SANDBOX_ISOLATED = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation allow-modals';

const LOAD_TIMEOUT_MS = 30_000;

/** Native error screens, keyed by the codes produced in src/web/error.rs. */
export const ERRORS = {
  EMBEDDING_NOT_ALLOWED: { icon: 'shield', title: 'Unable to load content', text: 'The destination does not allow this type of embedded access.' },
  SITE_UNAVAILABLE: { icon: 'wifiOff', title: 'Site unavailable', text: 'The destination couldn’t be reached. It may be offline, or refusing connections from this server.' },
  NETWORK_TIMEOUT: { icon: 'clock', title: 'The site took too long to respond', text: 'The connection timed out. Check your connection or try again.' },
  INVALID_URL: { icon: 'info', title: 'Invalid address', text: 'That doesn’t look like a web address LTF OS can open.' },
  BLOCKED_REQUEST: { icon: 'lock', title: 'This address is blocked', text: 'LTF OS doesn’t open private-network, internal or non-web addresses.' },
  PROXY_ERROR: { icon: 'info', title: 'Unable to load content', text: 'The content service couldn’t complete the request.' },
  PROXY_DISABLED: { icon: 'shield', title: 'Content service disabled', text: 'Isolated mode and remote fetching are turned off on this server.' },
  SERVER_ERROR: { icon: 'info', title: 'LTF OS server unavailable', text: 'The LTF OS server didn’t respond. It may be restarting.' },
  UNSUPPORTED_CONTENT: { icon: 'file', title: 'Unsupported content', text: 'This content can’t be displayed in an app window.' },
  RATE_LIMITED: { icon: 'clock', title: 'Too many requests', text: 'Please wait a moment and try again.' },
  TOO_LARGE: { icon: 'file', title: 'Content too large', text: 'This content exceeds the size limit for app windows.' },
  NOT_CONFIGURED: { icon: 'tab', title: 'No address configured', text: 'This app doesn’t have a target URL yet.' },
};

const isRemote = (url) => /^https?:\/\//i.test(url);

export function createFrame(opts = {}) {
  const {
    slot = 'app.content',
    title = 'Web content',
    allow = 'autoplay; fullscreen; picture-in-picture; clipboard-write; encrypted-media',
    check = true,
    onLoad, onError, onNavigate, onTitle, onOpen,
  } = opts;
  let sandbox = opts.sandbox; // undefined → default for the source; null → no sandbox attribute

  const loading = h('div.frame-loading', h('div.frame-spinner'));
  const notice = h('div.frame-notice', { hidden: true });
  // CREATOR SLOT: `data-slot` names this container. Its URL comes from the app
  // registry (static/apps.json → target) or from the owning app.
  const el = h('div.ltf-frame', { dataset: { slot } }, loading, notice);
  let iframe = null;
  let current = { url: null, isolated: false };
  let token = 0;
  let loadTimer = 0;
  let suspended = null;

  // Messages from isolated documents (the navigation shim in src/web/page.rs).
  // Accepted only from this frame's own window.
  const onMessage = (e) => {
    if (!iframe || e.source !== iframe.contentWindow || e.data?.source !== 'ltf-proxy') return;
    const d = e.data;
    if (d.type === 'navigate' && typeof d.url === 'string' && isRemote(d.url)) { current = { ...current, url: d.url }; onNavigate?.(d.url); }
    else if (d.type === 'title' && typeof d.title === 'string') onTitle?.(d.title.trim().slice(0, 120));
    else if (d.type === 'open' && isRemote(d.url)) (onOpen || ((u) => window.open(u, '_blank', 'noopener')))(d.url);
  };
  window.addEventListener('message', onMessage);

  function clearFrame() {
    clearTimeout(loadTimer);
    iframe?.remove();
    iframe = null;
  }

  /** Render a native LTF OS error screen for `code`. */
  function showError(code, { url, detail } = {}) {
    clearFrame();
    loading.hidden = true;
    const e = ERRORS[code] || ERRORS.PROXY_ERROR;
    notice.hidden = false;
    notice.className = `frame-notice frame-error${code === 'NOT_CONFIGURED' ? ' frame-placeholder' : ''}`;
    notice.dataset.code = code;
    notice.replaceChildren(
      h('div.frame-error-icon', { html: icons[e.icon] || icons.info }),
      h('h2', e.title),
      h('p', e.text),
      detail ? h('p.frame-error-detail', detail) : null,
      h('code', code === 'NOT_CONFIGURED' ? slot : code),
      h('div.frame-actions',
        code !== 'NOT_CONFIGURED' && code !== 'INVALID_URL' && code !== 'BLOCKED_REQUEST'
          ? h('button.btn.primary', { onclick: () => api_.reload() }, h('span', { html: icons.refresh }), 'Retry') : null,
        url && isRemote(url) && code !== 'BLOCKED_REQUEST' && code !== 'INVALID_URL'
          ? h('button.btn', { onclick: () => window.open(url, '_blank', 'noopener') }, h('span', { html: icons.external }), 'Open in browser tab') : null,
      ),
    );
    onError?.(code, { url, detail });
  }

  function mount(src, isolated) {
    clearFrame();
    notice.hidden = true;
    loading.hidden = false;
    iframe = h('iframe', {
      title,
      allow, // include "fullscreen" here; the legacy allowfullscreen attribute is redundant
      referrerpolicy: 'strict-origin-when-cross-origin',
    });
    const sb = isolated ? SANDBOX_ISOLATED : sandbox === undefined ? (isRemote(src) ? SANDBOX_WEB : null) : sandbox;
    if (sb) iframe.setAttribute('sandbox', sb);
    const mine = token;
    iframe.addEventListener('load', () => {
      if (mine !== token || iframe?.src === 'about:blank') return;
      clearTimeout(loadTimer);
      loading.hidden = true;
      onLoad?.(current);
    });
    loadTimer = setTimeout(() => {
      if (mine === token && !loading.hidden) showError('NETWORK_TIMEOUT', { url: current.url });
    }, LOAD_TIMEOUT_MS);
    iframe.src = src;
    el.prepend(iframe);
  }

  const api_ = {
    el,
    get iframe() { return iframe; },
    get current() { return current; },
    showError,

    /**
     * Load `url`. `isolated` renders through /proxy/page; `check: false`
     * skips the preflight (e.g. when the caller already inspected).
     */
    async load(url, { isolated = false, check: doCheck = check } = {}) {
      const mine = ++token;
      suspended = null;
      current = { url, isolated };
      if (!url) return showError('NOT_CONFIGURED');
      if (!isRemote(url)) return mount(url, false); // first-party content (relative URL)
      notice.hidden = true;
      loading.hidden = false;
      if (doCheck) {
        let info;
        try {
          info = await api.inspect(url);
        } catch (err) {
          if (mine === token) showError(err.code || (err.status ? 'PROXY_ERROR' : 'SERVER_ERROR'), { url, detail: err.message });
          return;
        }
        if (mine !== token) return;
        if (!info.ok) return showError(info.code || 'SITE_UNAVAILABLE', { url, detail: `HTTP ${info.status}` });
        if (!info.embeddable) {
          return showError('EMBEDDING_NOT_ALLOWED', { url, detail: `${new URL(info.final_url).host} sends ${info.blocked_by}.` });
        }
        if (isolated && !info.isolated_available) isolated = false; // non-HTML: nothing to isolate
        current = { url, isolated };
      }
      mount(isolated ? pageUrl(url) : url, isolated);
    },

    reload() {
      api_.load(current.url, { isolated: current.isolated, check });
    },

    /** Unload the page to free memory/CPU (e.g. while minimized); resume() reloads it. */
    suspend() {
      if (!iframe || suspended) return;
      suspended = { ...current };
      token++;
      clearFrame();
      loading.hidden = true;
    },

    resume() {
      if (!suspended) return;
      const s = suspended;
      suspended = null;
      api_.load(s.url, { isolated: s.isolated, check: false });
    },

    setSandbox(value) { sandbox = value; },

    /** postMessage to the embedded page (for integrations that support it). */
    post(message, targetOrigin = '*') { iframe?.contentWindow?.postMessage(message, targetOrigin); },

    destroy() {
      token++;
      clearTimeout(loadTimer);
      window.removeEventListener('message', onMessage);
      if (iframe) iframe.src = 'about:blank';
      el.remove();
    },
  };

  if (opts.url !== undefined) api_.load(opts.url, { isolated: !!opts.isolated });
  return api_;
}
