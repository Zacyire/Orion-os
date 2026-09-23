// Web-app container — turns a website into an LTF OS application.
//
// Every registry entry with "type": "web-app" is rendered by this module;
// nothing app-specific lives here. Registry fields (static/apps.json):
//
//   target       URL the app opens (required)                 "https://example.com/"
//   navigation   "limited" (default): the site navigates within itself; links to
//                other sites open in Orion. "none": pinned to the target page.
//   controls     title-bar buttons: "reload" | "home" | "external" | "panel"
//   proxy        "off" (default, direct iframe) | "isolated" (/proxy/page sandbox)
//   allow        iframe permissions policy (autoplay, fullscreen, gamepad, …)
//   sandbox      iframe sandbox tokens; null = none; omitted = frame.js default
//   fallback     module shown instead when the target can't be displayed
//                (e.g. the site forbids embedding) — must be a sanctioned
//                alternative such as an official embed/API client
//   panel        module in apps/panels/ shown by the "panel" control
//   suspendOnMinimize  unload the page while minimized to save memory/CPU
//
// Launch args override: { url, title, proxy, allow, size }.
// There is deliberately no address bar, tab strip or history UI here —
// Orion ("type": "browser") is the only general-purpose browser.

import { h } from '../core/dom.js';
import { createFrame } from '../core/frame.js';

const FALLBACK_CODES = new Set(['EMBEDDING_NOT_ALLOWED', 'SITE_UNAVAILABLE', 'NETWORK_TIMEOUT']);

/** Registrable-domain approximation: "www.cinejoy.pk" → "cinejoy.pk". */
const siteOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, '').split('.').slice(-2).join('.'); } catch { return ''; }
};

export default {
  // One window per web-app (like a native app); the hidden game host allows many.
  single: (app) => !app.hidden && app.single !== false,

  mount(root, ctx) {
    const app = ctx.app;
    const args = ctx.args || {};
    const target = args.url || app.target;
    const isolated = args.proxy === true || args.proxy === 'isolated' || app.proxy === 'isolated';
    let fallbackInstance = null;
    let panel = null;

    if (args.title) ctx.win.setTitle(args.title);

    const frame = createFrame({
      slot: `${app.id}.main`,
      title: args.title || app.name,
      allow: args.allow || app.allow,
      sandbox: 'sandbox' in app ? app.sandbox : undefined,
      onError: (code) => {
        if (app.fallback && FALLBACK_CODES.has(code)) mountFallback();
      },
      // Isolated documents report navigation; keep the app on its own site.
      onNavigate: (url) => {
        if (app.navigation === 'none' || (siteOf(url) && siteOf(url) !== siteOf(target))) {
          frame.load(target, { isolated, check: false });
          if (app.navigation !== 'none') ctx.open('orion', { url });
        }
      },
      onOpen: (url) => ctx.open('orion', { url }),
    });

    const container = h('div.app.webapp', frame.el);
    root.append(container);

    const CONTROL_DEFS = {
      reload: { icon: 'refresh', title: 'Reload', onClick: () => frame.reload() },
      home: { icon: 'home', title: 'Home', onClick: () => frame.load(target, { isolated }) },
      external: { icon: 'external', title: 'Open in browser tab', onClick: () => window.open(frame.current.url || target, '_blank', 'noopener') },
      panel: { icon: 'info', title: 'Details', onClick: (btn) => togglePanel(btn) },
    };
    ctx.win.setControls((app.controls || ['reload']).map((c) => CONTROL_DEFS[c]).filter(Boolean));

    async function togglePanel(btn) {
      if (panel) {
        panel.destroy?.();
        panel.el.remove();
        panel = null;
        btn?.classList.remove('active');
        return;
      }
      const el = h('aside.webapp-panel');
      container.append(el);
      btn?.classList.add('active');
      try {
        const mod = await import(`./panels/${app.panel}.js`);
        panel = { el, ...(mod.mountPanel(el, { ...ctx, frame, target, load: (url) => frame.load(url, { isolated }) }) || {}) };
      } catch (err) {
        el.textContent = `Panel unavailable: ${err.message}`;
        panel = { el };
      }
    }

    async function mountFallback() {
      if (fallbackInstance) return;
      try {
        const mod = await import(`./${app.fallback}.js`);
        frame.destroy();
        container.remove();
        ctx.win.setControls([{ icon: 'external', title: 'Open in browser tab', onClick: () => window.open(target, '_blank', 'noopener') }]);
        const r = await mod.default.mount(root, ctx);
        fallbackInstance = typeof r === 'function' ? { destroy: r } : r || {};
      } catch (err) {
        console.error('[webapp] fallback failed', err);
      }
    }

    frame.load(target, { isolated });

    return {
      onArgs(a) { if (a.url) frame.load(a.url, { isolated }); fallbackInstance?.onArgs?.(a); },
      onFocus() { frame.iframe?.focus(); fallbackInstance?.onFocus?.(); },
      onMinimize() { if (app.suspendOnMinimize) frame.suspend(); },
      onRestore() { if (app.suspendOnMinimize) frame.resume(); },
      destroy() {
        panel?.destroy?.();
        fallbackInstance?.destroy?.();
        frame.destroy();
      },
    };
  },
};
