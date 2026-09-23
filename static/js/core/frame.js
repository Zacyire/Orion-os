// AppFrame — the isolated content container used by every embed-based app.
//
//   const frame = createFrame({
//     slot: 'geforcenow.session',         // label shown in the empty placeholder
//     url: 'https://play.example.com/',   // omit → placeholder for the creator
//     proxy: false,                       // true → load through /proxy (sandboxed, opaque origin)
//     allow: 'autoplay; fullscreen',      // iframe permissions policy
//     sandbox: null,                      // null → no sandbox attribute (trusted embeds)
//     check: true,                        // pre-flight /api/frame-check; offer proxy / new tab if blocked
//     allowProxy: true,                   // offer "Load through proxy" when blocked
//   });
//   body.append(frame.el);
//   frame.load('https://…', { proxy: true });
//
// Direct (non-proxied) frames keep the provider's own origin, so services such
// as YouTube's embed player or cloud-gaming portals work with full capability.
// Proxied frames are always sandboxed without allow-same-origin.

import { h } from './dom.js';
import { icons } from './icons.js';
import { api, proxyUrl } from './api.js';

export const SANDBOX_PROXIED = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation allow-modals';
export const SANDBOX_WEB = `${SANDBOX_PROXIED} allow-same-origin allow-downloads`;

export function createFrame(opts = {}) {
  const {
    slot = 'app.content',
    allow = 'autoplay; fullscreen; picture-in-picture; clipboard-write; encrypted-media',
    title = 'Embedded content',
    check = false,
    placeholder = null,
    allowProxy = true,
    onLoad,
    onBlocked,
  } = opts;
  let { sandbox = null } = opts;

  const loading = h('div.frame-loading', h('div.frame-spinner'));
  const notice = h('div.frame-notice', { hidden: true });
  // CREATOR SLOT: the iframe below receives the URL for this app. Configure it
  // in content/*.json or static/apps.json (embed.url) — no markup changes needed.
  const el = h('div.ltf-frame', { dataset: { slot } }, loading, notice);
  let iframe = null;
  let current = { url: null, proxy: false };
  let token = 0;

  function showPlaceholder() {
    el.querySelector('iframe')?.remove();
    iframe = null;
    loading.hidden = true;
    notice.hidden = false;
    notice.className = 'frame-notice frame-placeholder';
    notice.replaceChildren(
      h('span', { html: icons.tab }),
      h('b', placeholder?.title || 'Embed slot'),
      h('code', slot),
      h('p', placeholder?.text || 'No URL is configured for this container yet. Set one in the app’s content file or pass a URL to frame.load().'),
    );
  }

  function makeIframe(src, proxied) {
    iframe?.remove();
    iframe = h('iframe', {
      title,
      allow, // include "fullscreen" here; the legacy allowfullscreen attribute is redundant
      referrerpolicy: 'strict-origin-when-cross-origin',
      loading: 'eager',
    });
    const sb = proxied ? SANDBOX_PROXIED : sandbox;
    if (sb) iframe.setAttribute('sandbox', sb);
    const mine = token;
    iframe.addEventListener('load', () => {
      if (mine !== token) return;
      loading.hidden = true;
      onLoad?.(current);
    });
    iframe.src = src;
    el.prepend(iframe);
  }

  function showBlocked(url, info) {
    loading.hidden = true;
    notice.hidden = false;
    notice.className = 'frame-notice';
    const host = (() => { try { return new URL(url).host; } catch { return url; } })();
    notice.replaceChildren(
      h('span', { html: icons.shield }),
      h('b', `${host} can’t be shown inside a window`),
      h('p', `The site sends ${info.blocked_by || 'a framing policy'} that forbids embedding.`),
      h('div.frame-actions',
        allowProxy && info.proxy_available ? h('button.btn.primary', { onclick: () => api_.load(url, { proxy: true, check: false }) }, 'Load through proxy') : null,
        h('button.btn', { onclick: () => window.open(url, '_blank', 'noopener') }, h('span', { html: icons.external }), 'Open in new tab'),
      ),
    );
    onBlocked?.(url, info);
  }

  const api_ = {
    el,
    get iframe() { return iframe; },
    get current() { return current; },

    async load(url, { proxy = false, check: doCheck = check } = {}) {
      const mine = ++token;
      current = { url, proxy };
      if (!url) return showPlaceholder();
      notice.hidden = true;
      loading.hidden = false;
      if (!proxy && doCheck && /^https?:/i.test(url)) {
        const info = await api.get(`/frame-check?url=${encodeURIComponent(url)}`).catch(() => null);
        if (mine !== token) return;
        if (info && !info.embeddable) {
          el.querySelector('iframe')?.remove();
          iframe = null;
          return showBlocked(url, info);
        }
      }
      makeIframe(proxy ? proxyUrl(url) : url, proxy);
    },

    reload() {
      if (current.url) api_.load(current.url, { proxy: current.proxy, check: false });
    },

    setSandbox(value) { sandbox = value; },

    /** postMessage to the embedded page (for creator integrations). */
    post(message, targetOrigin = '*') { iframe?.contentWindow?.postMessage(message, targetOrigin); },

    destroy() {
      token++;
      if (iframe) iframe.src = 'about:blank';
      el.remove();
    },
  };

  if (opts.url !== undefined) api_.load(opts.url, { proxy: !!opts.proxy });
  else showPlaceholder();
  return api_;
}
