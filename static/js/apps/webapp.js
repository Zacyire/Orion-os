// Web-app container — turns a website into an Orion OS application.
//
// Every registry entry with "type": "web-app" is rendered by this module;
// nothing app-specific lives here. Registry fields (static/apps.json):
//
//   runtime      how the target is loaded (default "direct"); ids are defined
//                once in core/runtimes.js and dispatched via RUNTIME_HANDLERS:
//                  "direct"   — load target in the existing sandboxed iframe
//                  "embed"    — same container; target is a provider-supplied
//                               embed URL (e.g. an official player)
//                  "external" — don't embed; a launcher screen that opens the
//                               site in the user's normal browser (for sites
//                               that don't permit framing)
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
// Launch args override: { url, title, runtime, proxy, allow, size } — except
// that the external runtime always uses the registry target (never args.url).
// There is deliberately no address bar, tab strip or history UI here —
// Orion ("type": "browser") is the only general-purpose browser.

import { h } from '../core/dom.js';
import { icons, appIcon } from '../core/icons.js';
import { createFrame } from '../core/frame.js';
import { RUNTIMES, normalizeRuntime } from '../core/runtimes.js';
import { trustedModule } from '../core/modules.js';

const FALLBACK_CODES = new Set(['EMBEDDING_NOT_ALLOWED', 'SITE_UNAVAILABLE', 'NETWORK_TIMEOUT']);

/** Registrable-domain approximation: "www.cinejoy.pk" → "cinejoy.pk". */
const siteOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, '').split('.').slice(-2).join('.'); } catch { return ''; }
};

// ─── Runtime handlers ───────────────────────────────────────────────────────
// One entry per id in core/runtimes.js. A handler's mount(env) renders into the
// window body and returns the standard mount instance (onArgs, onFocus,
// onMinimize, onRestore, destroy, …) that wm.js already drives — there is no
// separate runtime lifecycle. env = { root, ctx, app, args, target, isolated }.
//
// `direct` and `embed` share the frame handler: embed is currently a semantic
// label for "target is a provider embed URL", not a separate implementation
// (docs/runtime-architecture-review.md). `proxy: "isolated"` is not a runtime —
// it is passed to the frame handler as env.isolated and applied by frame.js.
export const RUNTIME_HANDLERS = Object.freeze({
  direct: Object.freeze({ mount: mountFrame }),
  embed: Object.freeze({ mount: mountFrame }),
  external: Object.freeze({ mount: mountExternal }),
});

/**
 * Resolve a requested runtime to { id, handler }. The request is normalized
 * against the authoritative list first (unknown/hostile → DEFAULT_RUNTIME), then
 * looked up as an OWN property of `handlers`, so inherited names such as
 * "constructor" can never act as handlers. A runtime that is defined but has no
 * handler resolves to handler: null — callers must fail closed rather than
 * substitute another runtime. `handlers` is injectable for contract tests.
 */
export function resolveRuntime(requested, handlers = RUNTIME_HANDLERS) {
  const id = normalizeRuntime(requested);
  return { id, handler: Object.hasOwn(handlers, id) ? handlers[id] : null };
}

/** Defined runtime ids that have no handler (should always be empty). */
export function missingRuntimeHandlers(handlers = RUNTIME_HANDLERS) {
  return RUNTIMES.filter((id) => !Object.hasOwn(handlers, id));
}

// Guard against a runtime being defined without a handler.
for (const id of missingRuntimeHandlers()) console.error(`[webapp] no handler for runtime "${id}"`);

/**
 * Mount `ctx.app` using `handlers` (the real table unless a test injects one).
 * Built-in and local apps take the same path: the manifest (or launch arg)
 * runtime goes through resolveRuntime().
 */
export function mountWithHandlers(root, ctx, handlers = RUNTIME_HANDLERS) {
  const app = ctx.app;
  const args = ctx.args || {};
  if (args.title) ctx.win.setTitle(args.title);

  // Built-in apps whose registry runtime is "external" are pinned: they are
  // operator-configured launcher entries (e.g. Roblox, CineJoy), so launch
  // arguments can change neither their destination nor their runtime (no
  // switching them into a frame, a proxy mode or another URL). User-created
  // local apps keep the documented launch-arg overrides.
  const pinned = app.runtime === 'external' && !app.local;
  const env = {
    root, ctx, app, args,
    target: pinned ? app.target : args.url || app.target,
    isolated: !pinned && (args.proxy === true || args.proxy === 'isolated' || app.proxy === 'isolated'),
  };
  const { id, handler } = resolveRuntime(pinned ? app.runtime : args.runtime || app.runtime, handlers);
  // Defined but unhandled: refuse to render rather than silently loading the
  // target through some other runtime's path.
  if (!handler) return mountUnavailable(env, id);
  return handler.mount(env);
}

export default {
  // One window per web-app (like a native app); the hidden game host allows many.
  single: (app) => !app.hidden && app.single !== false,

  mount(root, ctx) {
    return mountWithHandlers(root, ctx);
  },
};

// Fail-closed screen for a runtime that is defined but has no handler. Loads
// nothing (no iframe, no network request) and returns no lifecycle hooks.
function mountUnavailable({ root }, id) {
  console.error(`[webapp] runtime "${id}" has no handler; refusing to mount`);
  root.append(h('div.app.webapp', h('div.frame-notice.frame-error', { dataset: { code: 'RUNTIME_UNAVAILABLE' } },
    h('div.frame-error-icon', { html: icons.shield }),
    h('h2', 'App runtime unavailable'),
    h('p', 'This app uses a runtime that isn’t available in this version of Orion OS, so it wasn’t loaded.'),
    h('code', id),
  )));
}

// "external" runtime: never embed — hand the site to the user's normal
// browser. Used for destinations that don't permit framing (or can't be
// verified to), so the app is a launcher rather than a broken frame. Orion
// makes no network request and routes nothing: the browser opens the site
// directly, under its usual settings and network rules.
//
// The destination is always the registry's own `target` (operator-controlled
// for built-in apps, user-entered only for the user's own local apps). Launch
// arguments can never redirect it — `args.url` is ignored for this runtime.
function mountExternal({ root, ctx, app }) {
  const target = app.target;
  const host = (() => { try { return new URL(target).host; } catch { return ''; } })();
  const open = () => { if (host) window.open(target, '_blank', 'noopener,noreferrer'); };
  ctx.win.setControls([{ icon: 'external', title: 'Open in browser', onClick: open }]);
  const container = h('div.app.webapp');
  container.append(h('div.frame-notice.frame-placeholder.frame-external',
    h('div.frame-external-icon', appIcon(app, 'lg')),
    h('h2', app.name),
    h('p', `${app.name} opens in a normal browser tab. Your browser’s usual settings and network rules apply.`),
    host ? h('code', host) : h('code', 'no address configured'),
    h('div.frame-actions',
      // A real link, not window.open(): a user-clicked target="_blank" link is
      // an ordinary new-tab navigation, which popup rules and some managed
      // browsers treat more reliably than a script-opened tab. Same fixed
      // registry target; the browser's network rules still apply.
      host
        ? h('a.btn.primary', { href: target, target: '_blank', rel: 'noopener noreferrer' }, h('span', { html: icons.external }), `Open ${app.name}`)
        : h('button.btn.primary', { disabled: true }, h('span', { html: icons.external }), `Open ${app.name}`),
    ),
    h('p.frame-external-note', 'Orion OS doesn’t host, run or route this site.'),
  ));
  root.append(container);
  return {};
}

// "direct" / "embed" runtimes: the shared AppFrame (core/frame.js), which owns
// preflight, sandboxing, error screens and the isolated /proxy/page transport.
function mountFrame({ root, ctx, app, args, target, isolated }) {
  let fallbackInstance = null;
  let panel = null;

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
      const mod = await import(`./panels/${trustedModule('panel', app.panel)}.js`);
      panel = { el, ...(mod.mountPanel(el, { ...ctx, frame, target, load: (url) => frame.load(url, { isolated }) }) || {}) };
    } catch (err) {
      el.textContent = `Panel unavailable: ${err.message}`;
      panel = { el };
    }
  }

  async function mountFallback() {
    if (fallbackInstance) return;
    try {
      const mod = await import(`./${trustedModule('fallback', app.fallback)}.js`);
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
}
