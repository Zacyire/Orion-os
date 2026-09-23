import { h, $ } from './dom.js';
import { icons } from './icons.js';

/** Show a toast notification. type: info | success | error */
export function notify(title, message = '', { type = 'info', timeout = 4200 } = {}) {
  const el = h(`div.toast.${type}`, { role: 'status' },
    h('div', { html: type === 'error' ? icons.info : type === 'success' ? icons.check : icons.sparkles, style: { width: '20px', color: type === 'error' ? 'var(--danger)' : 'var(--accent-color)', flex: 'none' } }),
    h('div', h('b', title), message && h('p', message)),
  );
  el.addEventListener('click', () => dismiss(el));
  $('#toasts').append(el);
  if (timeout) setTimeout(() => dismiss(el), timeout);
  return el;
}

function dismiss(el) {
  if (!el.isConnected || el.classList.contains('out')) return;
  el.classList.add('out');
  el.addEventListener('animationend', () => el.remove(), { once: true });
}
