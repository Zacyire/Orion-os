// Generic embed app: renders a single URL in an AppFrame.
// Used by creator-added web apps (App Store → Add web app) and the Vapor
// game player window. Launch args: { url, proxy, title, allow, chrome }.
import { h } from '../core/dom.js';
import { icons } from '../core/icons.js';
import { createFrame } from '../core/frame.js';

export default {
  mount(root, ctx) {
    const cfg = { ...(ctx.app.embed || {}), ...ctx.args };
    let proxy = !!cfg.proxy;
    const frame = createFrame({
      slot: `${ctx.app.id}.frame`,
      title: cfg.title || ctx.app.name,
      allow: cfg.allow || 'autoplay; fullscreen; gamepad; picture-in-picture; clipboard-write; encrypted-media',
      // Relative URLs are first-party content served by LTF OS itself (e.g. the
      // bundled games) and run unsandboxed; host third-party games on their
      // own origin or set launch.type "proxy" to isolate them.
      sandbox: null,
      check: true,
      placeholder: { title: 'No URL configured', text: 'Pass { url } when opening this app, or set embed.url in static/apps.json.' },
    });
    if (cfg.title) ctx.win.setTitle(cfg.title);

    const bar = cfg.chrome === false ? null : h('div.app-toolbar.embed-bar',
      h('button.tool-btn', { title: 'Reload', html: icons.refresh, onclick: () => frame.reload() }),
      h('span.embed-url', cfg.url || ''),
      h('span.spacer'),
      /^https?:/i.test(cfg.url || '') ? h('button.tool-btn', {
        title: 'Toggle server proxy', class: `tool-btn${proxy ? ' active' : ''}`, html: icons.shield,
        onclick: (e) => { proxy = !proxy; e.currentTarget.classList.toggle('active', proxy); frame.load(cfg.url, { proxy, check: !proxy }); },
      }, 'Proxy') : null,
      /^https?:/i.test(cfg.url || '') ? h('button.tool-btn', { title: 'Open in new tab', html: icons.external, onclick: () => window.open(cfg.url, '_blank', 'noopener') }) : null,
    );
    root.append(h('div.app', bar, frame.el));
    frame.load(cfg.url, { proxy });
    return {
      onFocus: () => frame.iframe?.focus(),
      destroy: () => frame.destroy(),
    };
  },
};
