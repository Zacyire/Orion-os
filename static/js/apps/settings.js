// Settings — personalization, wallpaper, taskbar, account, sound, system.
import { h, syncRange, fill } from '../core/dom.js';
import { icons } from '../core/icons.js';
import { store } from '../core/store.js';
import { ACCENTS } from '../core/theme.js';
import { wallpaper } from '../core/wallpaper.js';
import { system } from '../core/system.js';
import { avatar } from '../core/user.js';

const PAGES = [
  { id: 'personalization', label: 'Personalization', icon: 'palette' },
  { id: 'taskbar', label: 'Taskbar', icon: 'taskbar' },
  { id: 'account', label: 'Account', icon: 'user' },
  { id: 'sound', label: 'Sound', icon: 'volume' },
  { id: 'system', label: 'System', icon: 'desktop' },
  { id: 'about', label: 'About', icon: 'info' },
];

export default {
  single: true,

  mount(root, ctx) {
    let page = ctx.args.page || 'personalization';
    const nav = h('nav.app-sidebar');
    const main = h('div.app-main');
    root.append(h('div.app', h('div.app-row', nav, main)));

    const row = (icon, title, desc, control) =>
      h('div.set-row', h('span', { html: icons[icon] }), h('div.set-text', title, desc ? h('small', desc) : null), control);
    const toggleRow = (icon, title, desc, checked, onChange) => {
      const input = h('input', { type: 'checkbox', checked });
      input.addEventListener('change', () => onChange(input.checked));
      return h('label.set-row', h('span', { html: icons[icon] }), h('div.set-text', title, h('small', desc)), h('span.toggle', input, h('i')));
    };
    const selectRow = (icon, title, desc, options, value, onChange) => {
      const sel = h('select.field', options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
      sel.addEventListener('change', () => onChange(sel.value));
      return row(icon, title, desc, sel);
    };
    const rangeRow = (icon, title, desc, { min, max, step = 1, value, format }, onInput) => {
      const r = h('input', { type: 'range', min, max, step, value });
      const out = h('span.set-value', format(value));
      syncRange(r);
      r.addEventListener('input', () => { syncRange(r); out.textContent = format(+r.value); onInput(+r.value); });
      return row(icon, title, desc, h('div.set-range', r, out));
    };

    function wallpaperGrid(th) {
      const current = wallpaper.current()?.id;
      return h('div.wp-grid', wallpaper.list().map((w) => {
        const thumb = h(`button.wp-thumb${w.id === current ? '.active' : ''}`, { title: w.credits || w.name });
        if (w.poster || w.type === 'image') thumb.style.backgroundImage = `url("${w.poster || w.src}")`;
        else if (w.type === 'procedural') thumb.style.background = 'radial-gradient(circle at 30% 35%, var(--accent-color), transparent 60%), radial-gradient(circle at 80% 70%, var(--accent-color-2), transparent 55%), #06070d';
        if (w.type === 'video') {
          // Live preview on hover.
          let v;
          thumb.addEventListener('pointerenter', () => {
            v = h('video', { src: w.src, muted: true, loop: true, autoplay: true, playsInline: true });
            v.muted = true;
            thumb.prepend(v);
          });
          thumb.addEventListener('pointerleave', () => { v?.remove(); v = null; });
        }
        thumb.append(h('span', w.name));
        if (w.type === 'video') thumb.append(h('i.wp-badge', 'LIVE'));
        thumb.addEventListener('click', () => { store.set('theme.wallpaper', w.id); setTimeout(draw, 50); });
        return thumb;
      }));
    }

    const pages = {
      personalization() {
        const th = store.get('theme');
        const custom = h('input', { type: 'color', value: th.accent, title: 'Custom colour', class: 'swatch-custom' });
        custom.addEventListener('input', () => store.set('theme.accent', custom.value));
        return [
          h('h1.page-title', 'Personalization'),
          h('div.section-title', 'Live wallpaper'),
          wallpaperGrid(th),
          h('p.muted.set-note', 'Add wallpapers by placing .mp4/.webm loops in static/media/wallpapers/ or listing them in content/wallpapers.json.'),
          toggleRow('sparkles', 'Play wallpaper animation', 'Pause to save power; the current frame stays on screen.', th.animateWallpaper, (v) => store.set('theme.animateWallpaper', v)),
          h('div.section-title', 'Colors'),
          selectRow('moon', 'Mode', 'Choose how Orion OS looks.', [['dark', 'Dark'], ['light', 'Light']], th.mode, (v) => store.set('theme.mode', v)),
          row('palette', 'Accent color', 'Highlights, focus rings and selection.',
            h('div.swatches', ...ACCENTS.map((c) => {
              const s = h(`button.swatch${c === th.accent ? '.active' : ''}`, { style: { background: c }, title: c, 'aria-label': `Accent ${c}` });
              s.addEventListener('click', () => { store.set('theme.accent', c); draw(); });
              return s;
            }), custom)),
          toggleRow('eye', 'Transparency effects', 'Acrylic and Mica blur on windows, menus and the taskbar.', th.transparency, (v) => { store.set('theme.transparency', v); draw(); }),
          th.transparency ? rangeRow('eye', 'Glass opacity', 'Sets --system-glass-opacity for all translucent surfaces.',
            { min: 0.3, max: 0.95, step: 0.01, value: th.glassOpacity ?? 0.62, format: (v) => `${Math.round(v * 100)}%` },
            (v) => store.set('theme.glassOpacity', v)) : null,
        ];
      },

      taskbar() {
        const tb = store.get('taskbar');
        return [
          h('h1.page-title', 'Taskbar'),
          h('div.section-title', 'Position on screen'),
          h('div.tb-pos-grid', { style: { marginBottom: '34px' } }, ['bottom', 'top', 'left', 'right'].map((p) => {
            const b = h(`button.tb-pos${tb.position === p ? '.active' : ''}`, { dataset: { pos: p } }, h('span', p[0].toUpperCase() + p.slice(1)));
            b.addEventListener('click', () => { store.set('taskbar.position', p); draw(); });
            return b;
          })),
          toggleRow('grid', 'Center taskbar icons', 'Align Start and apps to the middle of the taskbar.', tb.centered, (v) => store.set('taskbar.centered', v)),
          toggleRow('eye', 'Automatically hide the taskbar', 'Reveal it by moving the pointer to the screen edge.', tb.autoHide, (v) => store.set('taskbar.autoHide', v)),
          h('div.section-title', 'Pinned apps'),
          h('p.muted', 'Drag apps onto the taskbar from the desktop or Start to pin them; drag them onto the desktop to create shortcuts. Right-click a taskbar icon to unpin.'),
        ];
      },

      account() {
        const name = h('input.field', { value: store.get('user.name') || 'User', maxlength: 40, style: { maxWidth: '260px' } });
        name.addEventListener('change', () => { store.set('user.name', name.value.trim() || 'User'); draw(); });
        return [
          h('h1.page-title', 'Account'),
          h('div.card.account-card', avatar('lg'), h('div', h('h2', store.get('user.name') || 'User'), h('small.muted', 'Local account'))),
          h('div.section-title', 'Profile'),
          row('user', 'Display name', 'Shown in Start, on the lock screen and at sign-in.', name),
        ];
      },

      sound() {
        return [
          h('h1.page-title', 'Sound'),
          rangeRow('volume', 'Master volume', 'Applies to Spiceify, Vapor and other media apps.',
            { min: 0, max: 100, value: system.volume, format: (v) => `${v}%` }, (v) => system.setVolume(v)),
          toggleRow('mute', 'Mute', 'Silence all output.', system.muted, () => system.toggleMute()),
        ];
      },

      async system() {
        const info = await ctx.api.get('/system/info').catch(() => null);
        const feat = info?.features || {};
        const session = await ctx.api.get('/session').catch(() => null);
        const yes = (v) => h('span', { class: `chip ${v ? 'accent' : ''}` }, v ? 'Enabled' : 'Disabled');
        return [
          h('h1.page-title', 'System'),
          info ? h('div.card', h('dl.info-grid', ...Object.entries({
            'Version': `${info.name} ${info.version}`, 'Server': info.server,
            'Platform': `${info.platform} (${info.arch})`, 'Uptime': `${Math.floor(info.uptime_secs / 60)} min`,
          }).flatMap(([k, v]) => [h('dt', k), h('dd', v)]))) : h('div.card.muted', 'The Orion OS API server is unreachable. Preferences are stored in this browser until it returns.'),
          h('div.section-title', 'Server features'),
          row('shield', 'Web layer (isolated mode & /net/ fetching)', feat.proxy_allowlist?.length ? `Allowed hosts: ${feat.proxy_allowlist.join(', ')}` : 'Any public host (LTF_PROXY, LTF_PROXY_ALLOW). Sites that forbid embedding are never shown in windows.', yes(feat.proxy)),
          row('search', 'YouTube search', 'Requires YOUTUBE_API_KEY on the server.', yes(feat.youtube_search)),
          ...(session?.access_control ? [
            h('div.section-title', 'Access'),
            row('lock', 'Sign out', 'End this browser’s session. Local preferences and app data stay in this browser.',
              h('button.btn', { onclick: async () => { await fetch('/logout', { method: 'POST' }).catch(() => {}); location.assign('/'); } }, 'Sign out')),
            row('lock', 'Sign out and erase this browser', 'For shared or school computers: also deletes Orion OS data stored in this browser (drafts, bookmarks, history, app data, caches). Server files are kept.',
              h('button.btn.danger', { onclick: async () => {
                if (!confirm('Sign out and delete all Orion OS data stored in this browser?')) return;
                await fetch('/logout?erase=1', { method: 'POST' }).catch(() => {});
                location.assign('/');
              } }, 'Erase & sign out')),
          ] : []),
          h('div.section-title', 'Startup'),
          toggleRow('bolt', 'Fast startup', 'Skip the boot console animation.', store.get('boot.skipAnimation'), (v) => store.set('boot.skipAnimation', v)),
          h('div.section-title', 'Reset'),
          row('refresh', 'Reset preferences', 'Restore the default taskbar, desktop layout and theme.',
            h('button.btn.danger', { onclick: async () => { if (confirm('Reset all preferences?')) { await store.reset(); ctx.notify('Preferences reset'); draw(); } } }, 'Reset')),
        ];
      },

      about() {
        return [
          h('h1.page-title', 'About'),
          h('div.card.account-card', h('img', { src: 'assets/logo.svg', alt: '', style: { width: '64px', height: '64px' } }),
            h('div', h('h2', 'Orion OS'), h('p.muted', 'A desktop environment for games and media, served by a Rust API layer. Apps are isolated containers that embed real services and content.'))),
          h('div.section-title', 'Keyboard shortcuts'),
          h('dl.info-grid', ...[
            ['Ctrl + Space', 'Start'], ['Alt + W', 'Close window'], ['Alt + M', 'Minimize window'], ['Alt + ↑', 'Maximize / restore'],
            ['Alt + D', 'Show desktop'], ['Ctrl + Alt + L', 'Lock'],
          ].flatMap(([k, v]) => [h('dt', h('kbd', k)), h('dd', v)])),
        ];
      },
    };

    async function draw() {
      nav.replaceChildren(...PAGES.map((p) => {
        const b = h(`button.nav-item${p.id === page ? '.active' : ''}`, { html: icons[p.icon] }, p.label);
        b.addEventListener('click', () => { page = p.id; draw(); });
        return b;
      }));
      const scroll = main.scrollTop;
      fill(main, await pages[page]());
      main.scrollTop = scroll;
    }

    draw();
    const offs = ['taskbar'].map((s) => store.watch(s, () => page === 'taskbar' && draw()));
    return {
      onArgs(a) { if (a.page) { page = a.page; draw(); } },
      destroy() { offs.forEach((o) => o()); },
    };
  },
};
