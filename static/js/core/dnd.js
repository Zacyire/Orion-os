// Pointer-based drag & drop for app icons (taskbar ⇄ desktop ⇄ start menu).
// Native HTML5 DnD can't give us a styled ghost or smooth grid snapping,
// so we roll our own with pointer events.

import { h, $ } from './dom.js';
import { appIcon } from './icons.js';
import { registry } from './registry.js';

const THRESHOLD = 6;
const targets = new Set();

export const dnd = {
  active: null,
  suppressClick: false,

  /**
   * Register a drop target.
   * { el, accepts(p), over(p, x, y), leave(p), drop(p, x, y), hitTest?(x, y), label?(p) }
   * Targets registered earlier are checked last (taskbar registers after desktop so it wins).
   */
  register(target) {
    targets.add(target);
    return () => targets.delete(target);
  },

  /** Begin tracking a potential drag from a pointerdown event. */
  track(e, payload) {
    if (e.button !== 0) return;
    const sx = e.clientX;
    const sy = e.clientY;
    let ghost = null;
    let current = null;

    const move = (ev) => {
      if (!ghost) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < THRESHOLD) return;
        const app = registry.get(payload.appId);
        if (!app) return;
        ghost = h('div.drag-ghost', appIcon(app), h('span', payload.hint?.(null) || app.name));
        $('#drag-layer').append(ghost);
        payload.sourceEl?.classList.add('dragging');
        this.active = payload;
        document.body.classList.add('is-dragging');
      }
      ghost.style.left = `${ev.clientX}px`;
      ghost.style.top = `${ev.clientY}px`;

      const hit = [...targets].reverse().find((t) => t.accepts(payload) && (t.hitTest ? t.hitTest(ev.clientX, ev.clientY) : inside(t.el, ev.clientX, ev.clientY)));
      if (hit !== current) {
        current?.leave?.(payload);
        current = hit;
      }
      current?.over?.(payload, ev.clientX, ev.clientY);
      const label = ghost.querySelector('span');
      label.textContent = current?.label?.(payload) || registry.get(payload.appId).name;
    };

    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (!ghost) return;
      ghost.remove();
      payload.sourceEl?.classList.remove('dragging');
      document.body.classList.remove('is-dragging');
      this.active = null;
      this.suppressClick = true;
      setTimeout(() => (this.suppressClick = false), 60);
      if (current && ev.type === 'pointerup') {
        current.leave?.(payload);
        current.drop(payload, ev.clientX, ev.clientY);
      } else {
        current?.leave?.(payload);
        payload.onNoDrop?.(ev.clientX, ev.clientY);
      }
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  },
};

function inside(el, x, y) {
  const r = el.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}
