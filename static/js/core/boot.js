// Startup splash: Orion branding while the real startup work runs.
//
// Honest by construction: the progress bar and status line only report the
// real steps `work` performs (preferences, apps, desktop, wallpaper) and the
// real outcome — there is no simulated kernel, hardware or network output.
//
// Timing:
//   • The splash stays up until the real work is done (it cannot reveal a
//     desktop that doesn't exist yet). Boot-time requests have their own
//     timeouts (app.js), so a slow or absent server can't hold it forever.
//   • Beyond that it adds at most a short branded minimum: ~1.0 s on the
//     first visit, ~0.35 s on later visits, 0 with "Fast startup" or reduced
//     motion. Esc / the Skip button drop the minimum immediately.
//   • If the server was unreachable, the splash says so for ~1.2 s (skippable).
//
// Lifecycle: listeners are removed and the overlay is always removed in a
// `finally`, with a timeout fallback in case transitionend never fires.
// Performance marks (orion-boot-start / -ready / -end) record the timeline.

import { $, local } from './dom.js';
import { online, isStatic } from './api.js';

const FIRST_VISIT_MIN_MS = 1000;
const RETURN_VISIT_MIN_MS = 350;
const NOTICE_MS = 1200;
const FADE_MS = 420;

export async function runBoot(work) {
  const boot = $('#boot');
  const bar = $('#boot-bar-fill');
  const progressEl = boot?.querySelector('.boot-progress');
  const status = $('#boot-status');
  const skipBtn = $('#boot-skip');
  performance.mark('orion-boot-start');
  const started = performance.now();

  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fastStartup = local.get('prefs')?.boot?.skipAnimation === true;
  const firstVisit = !local.get('entry')?.seen;
  const minMs = reducedMotion || fastStartup ? 0 : firstVisit ? FIRST_VISIT_MIN_MS : RETURN_VISIT_MIN_MS;

  // Skip: resolves `skipped` once; every wait below races against it.
  let skip;
  const skipped = new Promise((resolve) => { skip = resolve; });
  let isSkipped = false;
  const onSkip = () => { isSkipped = true; skip(); };
  const onKey = (e) => { if (e.key === 'Escape') onSkip(); };
  window.addEventListener('keydown', onKey);
  skipBtn?.addEventListener('click', onSkip);
  const wait = (ms) => (ms > 0 && !isSkipped ? Promise.race([new Promise((r) => setTimeout(r, ms)), skipped]) : Promise.resolve());

  const setState = (state) => { if (boot) boot.dataset.state = state; };
  const setStatus = (text) => { if (status) status.textContent = text; };
  const setProgress = (fraction) => {
    const v = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
    if (bar) bar.style.width = `${v}%`;
    progressEl?.setAttribute('aria-valuenow', String(v));
  };

  // `work` reports its real steps through this callback.
  const report = (label, fraction) => { setStatus(label); setProgress(fraction); };

  setState('working');
  let failure = null;
  try {
    try {
      await work({ report });
    } catch (err) {
      failure = err;
    }
    performance.mark('orion-boot-ready');

    if (failure) {
      // Honest failure: say what happened and offer a reload, then let the
      // (partial) desktop through so the page never stays blocked.
      console.error(failure);
      setState('error');
      setProgress(1);
      setStatus(`Orion OS couldn’t finish starting: ${failure.message || 'unknown error'}`);
      showReload(boot);
      await wait(4000);
    } else {
      setProgress(1);
      if (!online) {
        setState('offline');
        setStatus(isStatic
          ? 'Static edition — Orion server unavailable. Settings are saved in this browser.'
          : 'Orion server unavailable — using settings saved in this browser.');
        await wait(NOTICE_MS);
      } else {
        setState('ready');
        setStatus('Ready');
      }
      await wait(minMs - (performance.now() - started));
    }
  } finally {
    window.removeEventListener('keydown', onKey);
    skipBtn?.removeEventListener('click', onSkip);
    await reveal(boot, reducedMotion || isSkipped);
    performance.mark('orion-boot-end');
  }
  return { firstVisit, failed: !!failure };
}

/** Fade the splash out, reveal the desktop, and always remove the overlay. */
function reveal(boot, instant) {
  document.body.classList.remove('booting');
  if (!boot) return Promise.resolve();
  if (instant) { boot.remove(); return Promise.resolve(); }
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); boot.remove(); resolve(); };
    const timer = setTimeout(done, FADE_MS + 200); // transitionend may never fire
    boot.addEventListener('transitionend', (e) => { if (e.target === boot && e.propertyName === 'opacity') done(); });
    boot.classList.add('fade-out');
  });
}

function showReload(boot) {
  const actions = boot?.querySelector('#boot-actions');
  if (!actions) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn';
  btn.textContent = 'Reload';
  btn.addEventListener('click', () => location.reload());
  actions.replaceChildren(btn);
  actions.hidden = false;
}
