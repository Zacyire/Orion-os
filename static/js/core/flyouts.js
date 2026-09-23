// Only one shell flyout (start, quick settings, calendar) is open at a time.
import { $ } from './dom.js';
import { bus } from './events.js';

let current = null; // { el, btn, onClose }

export const flyouts = {
  get current() {
    return current?.el.id ?? null;
  },

  open(el, btn, { onOpen, onClose } = {}) {
    if (current?.el === el) return;
    this.close(true);
    el.hidden = false;
    el.classList.remove('closing');
    btn?.classList.add('active-flyout');
    $('#taskbar').classList.add('pinned-open');
    current = { el, btn, onClose };
    onOpen?.();
    bus.emit('flyout', el.id);
  },

  toggle(el, btn, hooks) {
    if (current?.el === el) this.close();
    else this.open(el, btn, hooks);
  },

  close(instant = false) {
    if (!current) return;
    const { el, btn, onClose } = current;
    current = null;
    btn?.classList.remove('active-flyout');
    $('#taskbar').classList.remove('pinned-open');
    onClose?.();
    if (instant) {
      el.hidden = true;
      return;
    }
    el.classList.add('closing');
    setTimeout(() => {
      if (current?.el !== el) {
        el.hidden = true;
        el.classList.remove('closing');
      }
    }, 200);
  },
};

window.addEventListener('pointerdown', (e) => {
  if (!current) return;
  if (current.el.contains(e.target) || current.btn?.contains(e.target)) return;
  if (e.target.closest('#context-menu')) return;
  flyouts.close();
}, true);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') flyouts.close();
});
