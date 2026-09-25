// Clock — third first-party desktop widget.
//
// A floating glass clock showing the user's LOCAL time and date. It reads the
// browser/device clock directly (new Date()); there is no backend, no
// geolocation and no timezone maths — the platform's locale and timezone are
// used as-is. The top-bar tray keeps its own compact clock; this is the larger
// desktop widget.
//
// Updating: a self-scheduling timeout re-aligns to each second boundary, so it
// never drifts and never fires twice per second. Every tick reads a fresh Date,
// so minute/hour/day/month transitions (including midnight) update naturally.

import { h } from '../core/dom.js';

// 12-hour time with AM/PM in the user's locale/timezone, e.g. "8:07 PM".
const TIME_FMT = { hour: 'numeric', minute: '2-digit', hour12: true };
// e.g. "Thursday, September 24".
const DATE_FMT = { weekday: 'long', month: 'long', day: 'numeric' };

export const clock = {
  id: 'clock',

  mount(root) {
    // <time> is the semantic element; its datetime + aria-label give assistive
    // tech a full, unambiguous reading while the visible text stays compact.
    const timeEl = h('time.clock-time');
    const dateEl = h('div.clock-date');
    root.append(h('div.clock', timeEl, dateEl));

    let timer = 0;
    let disposed = false;

    function render() {
      const now = new Date();
      const time = now.toLocaleTimeString([], TIME_FMT);
      const date = now.toLocaleDateString([], DATE_FMT);
      timeEl.textContent = time;
      timeEl.setAttribute('datetime', now.toISOString());
      timeEl.setAttribute('aria-label', `${time}, ${date}`);
      dateEl.textContent = date;
    }

    function schedule() {
      // Fire at the start of the next second, so the display flips cleanly and
      // the interval can't accumulate drift.
      const delay = 1000 - (Date.now() % 1000);
      timer = setTimeout(() => {
        if (disposed) return;
        render();
        schedule();
      }, delay);
    }

    render(); // show the correct time immediately, not after a full second
    schedule();

    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  },
};
