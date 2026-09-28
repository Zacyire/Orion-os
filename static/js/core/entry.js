// Entry overlays: the first-visit welcome and the local screen lock.
//
// PRESENTATION ONLY — this is not authentication. Orion's security boundary
// is the server sign-in (src/auth.rs: access key, session cookie). Nothing
// here checks a key, knows about the session, or protects data; the lock
// simply covers the desktop until the user continues. It shows no account or
// session information.
//
//   entry.welcome()  first visit in this browser: "Enter Orion"; remembered
//                    in localStorage (ltf:entry) so it appears once.
//   entry.lock()     Ctrl+Alt+L / Start → Lock: clock, date, "Unlock".
//
// While an overlay is open:
//   • the desktop (#shell) is `inert` — no clicks or focus can reach it, so
//     Tab moves only between the overlay and the browser UI (no focus trap);
//   • keystrokes are captured before the desktop's shortcuts see them;
//   • windows, widgets and apps keep running untouched underneath (the work
//     area is only faded out so the wallpaper shows through).
// Closing removes every listener and timer it added, restores focus to where
// it was, and never reloads anything. Only one overlay can exist at a time.

import { h, $, local } from './dom.js';
import { icons } from './icons.js';

const LEAVE_MS = 360;
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab', 'Fn', 'OS']);

let active = null;

const mark = () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'entry-mark');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#orion-mark');
  svg.append(use);
  return svg;
};

function open(mode) {
  if (active) return active.api;
  const shell = $('#shell');
  const returnFocus = document.activeElement;
  let timer = 0;
  let closed = false;

  const action = h('button.entry-action', { type: 'button' },
    h('span', mode === 'lock' ? 'Unlock' : 'Enter Orion'),
    h('span.entry-action-ico', { html: icons.arrowRight }),
  );

  let content;
  if (mode === 'lock') {
    const time = h('time.entry-time');
    const date = h('div.entry-date');
    const tick = () => {
      const d = new Date();
      time.textContent = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      time.dateTime = d.toISOString();
      date.textContent = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    };
    tick();
    timer = setInterval(tick, 1000);
    content = [
      h('div.entry-clock', time, date),
      h('div.entry-foot', mark(), h('p.entry-hint', 'Click or press any key to continue'), action),
    ];
  } else {
    content = [
      h('div.entry-card',
        mark(),
        h('h1.entry-title', 'Welcome to ', h('b', 'Orion OS')),
        h('p.entry-lead', 'Your apps, games and media in one desktop, right in the browser.'),
        action,
        h('p.entry-hint', 'Press ', h('kbd', 'Enter'), ' to continue'),
      ),
    ];
  }

  const el = h('section#entry-screen', {
    role: 'dialog', 'aria-modal': 'true',
    'aria-label': mode === 'lock' ? 'Screen locked' : 'Welcome to Orion OS',
    dataset: { mode },
  }, ...content);

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    window.removeEventListener('keydown', onKey, true);
    el.removeEventListener('click', onClick);
    if (mode === 'welcome') local.set('entry', { seen: Date.now() });
    if (shell) shell.inert = false;
    document.body.classList.remove('entry-open');
    el.classList.add('leaving');
    const remove = () => { clearTimeout(fallback); el.remove(); };
    const fallback = setTimeout(remove, LEAVE_MS + 150);
    el.addEventListener('animationend', (e) => { if (e.target === el) remove(); });
    if (returnFocus?.isConnected && returnFocus !== document.body && typeof returnFocus.focus === 'function') {
      returnFocus.focus({ preventScroll: true });
    }
    active = null;
  }

  // Capture phase: the desktop's own shortcuts (Alt+W, Ctrl+Space, …) must
  // never fire underneath an overlay.
  function onKey(e) {
    if (MODIFIERS.has(e.key)) return; // modifiers alone and Tab behave normally
    e.stopPropagation();
    const activates = e.key === 'Enter' || e.key === ' ';
    if (e.ctrlKey || e.metaKey || e.altKey) {
      // Browser shortcuts (reload, tabs…) keep working, but a modified
      // Enter/Space (e.g. Ctrl+Space) must not "press" the focused button.
      if (activates) e.preventDefault();
      return;
    }
    if (e.target === action && activates) return; // native button activation
    if (mode === 'lock' || e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }
  // Lock: a click anywhere continues. Welcome: only the button does (Enter /
  // Space on the focused button arrive here as its native click).
  function onClick(e) { if (mode === 'lock' || e.target.closest('.entry-action')) close(); }

  window.addEventListener('keydown', onKey, true);
  el.addEventListener('click', onClick);
  if (shell) shell.inert = true;
  document.body.classList.add('entry-open');
  document.body.append(el);
  action.focus({ preventScroll: true });

  active = { mode, api: { mode, close } };
  return active.api;
}

export const entry = {
  /** First-entry welcome (shown once per browser). */
  welcome() { return open('welcome'); },
  /** Local screen lock — presentation only, not authentication. */
  lock() { return open('lock'); },
  /** Whether this browser has already seen the welcome. */
  get seen() { return !!local.get('entry')?.seen; },
  get active() { return active?.mode ?? null; },
};
