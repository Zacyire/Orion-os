// Context menu. Items: { label, icon, action, kbd, checked, disabled, danger, submenu: [...] }
// or '-' for a separator, or { heading: 'Text' }.

import { h, $, clamp } from './dom.js';
import { icons } from './icons.js';

function build(items, close) {
  return items.filter(Boolean).map((item) => {
    if (item === '-') return h('div.cm-sep');
    if (item.heading) return h('div.cm-label', item.heading);
    const btn = h('button.cm-item', { role: 'menuitem', disabled: !!item.disabled, class: `cm-item${item.danger ? ' danger' : ''}` },
      h('span', { html: icons[item.icon] || '', style: { width: '15px', display: 'grid' } }),
      h('span', item.label),
      item.checked ? h('span.cm-check', { html: icons.check, style: { width: '15px' } }) : null,
      item.kbd ? h('kbd', item.kbd) : null,
      item.submenu ? h('span', { html: icons.chevronRight, style: { marginLeft: 'auto', width: '14px', display: 'grid' } }) : null,
    );
    if (item.submenu) {
      btn.append(h('div.cm-sub', h('div.cm-sub-panel', build(item.submenu, close))));
    } else {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        close();
        item.action?.();
      });
    }
    return btn;
  });
}

export const contextMenu = {
  el: null,

  open(x, y, items) {
    const el = (this.el ||= $('#context-menu'));
    el.replaceChildren(...build(items, () => this.close()));
    el.hidden = false;
    el.classList.remove('flip-sub');
    const r = el.getBoundingClientRect();
    const left = clamp(x, 4, innerWidth - r.width - 4);
    const top = y + r.height > innerHeight - 4 ? Math.max(4, y - r.height) : y;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    if (left + r.width + 190 > innerWidth) el.classList.add('flip-sub');
    el.querySelector('.cm-item:not(:disabled)')?.focus({ preventScroll: true });
  },

  close() {
    if (this.el) this.el.hidden = true;
  },
};

// Global dismissal
window.addEventListener('pointerdown', (e) => {
  if (contextMenu.el && !contextMenu.el.hidden && !contextMenu.el.contains(e.target)) contextMenu.close();
}, true);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') contextMenu.close();
});
window.addEventListener('blur', () => contextMenu.close());
