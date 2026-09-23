// Settings — personalization, taskbar, widgets, system info.
import { h, syncRange } from '../core/dom.js';
import { icons } from '../core/icons.js';
import { store } from '../core/store.js';
import { ACCENTS } from '../core/theme.js';
import { MODES } from '../core/wallpaper.js';
import { widgets, WIDGETS } from '../core/widgets.js';
import { system } from '../core/system.js';
import { local } from '../core/dom.js';

const PAGES = [
  { id: 'personalization', label: 'Personalization', icon: 'palette' },
  { id: 'taskbar', label: 'Taskbar', icon: 'taskbar' },
  { id: 'widgets', label: 'Widgets', icon: 'widgets' },
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

    const toggleRow = (icon, title, desc, checked, onChange) => {
      const input = h('input', { type: 'checkbox', checked });
      input.addEventListener('change', () => onChange(input.checked));
      return h('label.set-row', h('span', { html: icons[icon] }), h('div.set-text', title, h('small', desc)), h('span.toggle', input, h('i')));
    };
    const selectRow = (icon, title, desc, options, value, onChange) => {
      const sel = h('select.field', options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
      sel.addEventListener('change', () => onChange(sel.value));
      return h('div.set-row', h('span', { html: icons[icon] }), h('div.set-text', title, h('small', desc)), sel);
    };

    const pages = {
      personalization() {
        const th = store.get('theme');
        const custom = h('input', { type: 'color', value: th.accent, title: 'Custom colour', style: { width: '34px', height: '34px', border: 0, background: 'none', padding: 0 } });
        custom.addEventListener('input', () => store.set('theme.accent', custom.value));
        return [
          h('h1.page-title', 'Personalization'),
          h('div.section-title', 'Background'),
          h('div.wp-grid', MODES.map((m) => {
            const b = h(`button.wp-thumb${th.wallpaper === m.id ? '.active' : ''}`, { style: { background: thumbBg(m.id) } }, h('span', m.name));
            b.addEventListener('click', () => { store.set('theme.wallpaper', m.id); draw(); });
            return b;
          })),
          h('div', { style: { height: '10px' } }),
          toggleRow('sparkles', 'Animate live wallpaper', 'Pause to save CPU/GPU and battery.', th.animateWallpaper, (v) => store.set('theme.animateWallpaper', v)),
          h('div.section-title', 'Colors'),
          selectRow('moon', 'Mode', 'Choose how LTF OS looks.', [['dark', 'Dark'], ['light', 'Light']], th.mode, (v) => store.set('theme.mode', v)),
          toggleRow('eye', 'Transparency effects', 'Acrylic & Mica blur on windows and the taskbar.', th.transparency, (v) => store.set('theme.transparency', v)),
          h('div.set-row', h('span', { html: icons.palette }), h('div.set-text', 'Accent color', h('small', 'Used for highlights, the wallpaper and focus rings.')),
            h('div.swatches', ...ACCENTS.map((c) => {
              const s = h(`button.swatch${c === th.accent ? '.active' : ''}`, { style: { background: c }, title: c, 'aria-label': `Accent ${c}` });
              s.addEventListener('click', () => { store.set('theme.accent', c); draw(); });
              return s;
            }), custom),
          ),
        ];
      },

      taskbar() {
        const tb = store.get('taskbar');
        return [
          h('h1.page-title', 'Taskbar'),
          h('div.section-title', 'Taskbar position'),
          h('div.tb-pos-grid', { style: { marginBottom: '34px' } }, ['bottom', 'top', 'left', 'right'].map((p) => {
            const b = h(`button.tb-pos${tb.position === p ? '.active' : ''}`, { dataset: { pos: p } }, h('span', p[0].toUpperCase() + p.slice(1)));
            b.addEventListener('click', () => { store.set('taskbar.position', p); draw(); });
            return b;
          })),
          toggleRow('grid', 'Center taskbar icons', 'Windows 11 style centered alignment.', tb.centered, (v) => store.set('taskbar.centered', v)),
          toggleRow('eye', 'Automatically hide the taskbar', 'Reveal it by moving the pointer to the screen edge.', tb.autoHide, (v) => store.set('taskbar.autoHide', v)),
          h('div.section-title', 'Pinned apps'),
          h('p.muted', 'Drag apps onto the taskbar from the desktop or Start to pin them. Drag them back to the desktop to create shortcuts.'),
          h('div.card', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, tb.pinned.map((id) => h('span.chip.accent', id))),
        ];
      },

      widgets() {
        const cfg = store.get('widgets');
        return [
          h('h1.page-title', 'Widgets'),
          toggleRow('widgets', 'Show widgets on desktop', 'Also toggled with the widgets button on the taskbar.', !document.body.classList.contains('widgets-hidden'), (v) => {
            document.body.classList.toggle('widgets-hidden', !v);
            local.set('widgetsHidden', !v);
          }),
          h('div.section-title', 'Available widgets'),
          ...WIDGETS.map((w) => toggleRow(w.icon, w.title, 'Drag its header to move it anywhere.', cfg[w.id]?.visible, (v) => widgets.setVisible(w.id, v))),
          selectRow('clock', 'Clock style', 'Or click the clock widget to switch.', [['digital', 'Digital'], ['analog', 'Analog']], cfg.clock?.style || 'digital', (v) => store.set('widgets.clock.style', v)),
        ];
      },

      sound() {
        const range = h('input', { type: 'range', min: 0, max: 100, value: system.volume });
        syncRange(range);
        range.addEventListener('input', () => { system.setVolume(+range.value); syncRange(range); });
        return [
          h('h1.page-title', 'Sound'),
          h('div.set-row', h('span', { html: icons.volume }), h('div.set-text', 'Master volume', h('small', 'Applies to Groove, Cinema and games.')), h('div', { style: { width: '200px' } }, range)),
          toggleRow('mute', 'Mute', 'Silence all output.', system.muted, () => system.toggleMute()),
        ];
      },

      async system() {
        const info = await ctx.api.get('/system/info').catch(() => null);
        const box = h('div.card');
        if (info) {
          box.append(h('dl.info-grid', ...Object.entries({
            'OS': `${info.name} ${info.version} “${info.codename}”`, 'Kernel': info.kernel, 'Host': info.host,
            'Architecture': `${info.arch} (${info.platform})`, 'CPU': info.cpu, 'GPU': info.gpu,
            'Uptime': `${Math.floor(info.uptime_secs / 60)} min`,
          }).flatMap(([k, v]) => [h('dt', k), h('dd', v)])));
        } else box.append(h('p.muted', 'The kernel (Rust backend) is offline. Running in local mode.'));
        return [
          h('h1.page-title', 'System'),
          box,
          h('div.section-title', 'Startup'),
          toggleRow('bolt', 'Fast boot', 'Skip the Arch-style boot log animation.', store.get('boot.skipAnimation'), (v) => store.set('boot.skipAnimation', v)),
          h('div.section-title', 'Reset'),
          h('div.set-row', h('span', { html: icons.refresh }), h('div.set-text', 'Reset preferences', h('small', 'Restore default taskbar, desktop, theme and widgets.')),
            h('button.btn.danger', { onclick: async () => { await store.reset(); ctx.notify('Preferences reset'); draw(); } }, 'Reset')),
        ];
      },

      about() {
        return [
          h('h1.page-title', 'About LTF OS'),
          h('div.card', { style: { display: 'flex', gap: '20px', alignItems: 'center' } },
            h('img', { src: 'assets/ninja-ltf.svg', alt: '', style: { width: '96px', height: '96px' } }),
            h('div',
              h('h2', { style: { margin: 0 } }, 'LTF OS'),
              h('p.muted', { style: { margin: '4px 0' } }, 'Low Taper Fade Edition'),
              h('p', { style: { margin: 0 } }, 'A web desktop with a Rust (Axum) kernel and a vanilla-JS shell. Imagine if Ninja got a low taper fade — and an operating system.'),
            ),
          ),
          h('div.section-title', 'Keyboard shortcuts'),
          h('dl.info-grid', ...[
            ['Ctrl + Space', 'Start menu'], ['Alt + W', 'Close window'], ['Alt + M', 'Minimize window'], ['Alt + ↑', 'Maximize / restore'],
            ['Alt + D', 'Show desktop'], ['Ctrl + Alt + T', 'Terminal'], ['Ctrl + Alt + L', 'Lock'],
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
      const content = await pages[page]();
      main.replaceChildren(...content);
    }

    draw();
    const offs = ['theme', 'taskbar', 'widgets'].map((s) => store.watch(s, () => { if (page !== 'widgets') draw(); }));
    return {
      onArgs(a) { if (a.page) { page = a.page; draw(); } },
      destroy() { offs.forEach((o) => o()); },
    };
  },
};

function thumbBg(id) {
  if (id === 'aurora') return 'radial-gradient(circle at 30% 30%, var(--accent), transparent 60%), radial-gradient(circle at 80% 70%, #ff3cac, transparent 55%), #0d0f22';
  if (id === 'synthwave') return 'linear-gradient(#0a0014 0 40%, transparent 40%), radial-gradient(circle at 50% 55%, #ffd319 0 12%, #ff2975 20%, transparent 22%), linear-gradient(#3b0a45, #120018)';
  return 'radial-gradient(circle at 25% 30%, color-mix(in srgb, var(--accent) 60%, transparent), transparent 50%), radial-gradient(circle, #fff 1px, transparent 1.5px) 0 0 / 22px 22px, #0b0d18';
}
