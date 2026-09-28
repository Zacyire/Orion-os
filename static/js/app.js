// Orion OS — frontend entry point.
import { runBoot } from './core/boot.js';
import { store } from './core/store.js';
import { registry } from './core/registry.js';
import { connectEvents, isStatic } from './core/api.js';
import { initTheme } from './core/theme.js';
import { wm } from './core/wm.js';
import { taskbar } from './core/taskbar.js';
import { startMenu } from './core/startmenu.js';
import { desktop } from './core/desktop.js';
import { wallpaper } from './core/wallpaper.js';
import { flyouts } from './core/flyouts.js';
import { power } from './core/power.js';
import { initAppBridge } from './core/appbridge.js';
import { widgets } from './core/widgets.js';
import { entry } from './core/entry.js';

// Deadline for each boot-time server request. If the server is slow or
// absent, startup continues with the copies saved in this browser (or the
// static apps.json) instead of waiting forever.
const BOOT_REQUEST_TIMEOUT_MS = 6000;

/** Real startup work. `report(label, fraction)` drives the splash (boot.js). */
async function init({ report = () => {} } = {}) {
  const timeout = BOOT_REQUEST_TIMEOUT_MS;
  report('Loading your preferences', 0.1);
  await store.load({ timeout });
  initTheme();
  report('Loading apps', 0.35);
  await registry.load({ timeout });
  report('Preparing the desktop', 0.6);
  wm.init();
  taskbar.init();
  startMenu.init();
  desktop.init();
  widgets.init();
  report('Loading wallpaper', 0.8);
  await wallpaper.init({ timeout });
  connectEvents();
  bindShortcuts();
  registerServiceWorker();
  initAppBridge(); // window.ltf bridge for first-party app frames
}

/** static/sw.js: /net/ resource caching + offline shell. Never blocks boot. */
function registerServiceWorker() {
  // The worker serves /net/ and the offline shell for the full (server) edition.
  if (isStatic || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => console.warn('[sw] registration failed', err));
}

function bindShortcuts() {
  window.addEventListener('keydown', (e) => {
    if (document.body.classList.contains('booting')) return;
    if (e.ctrlKey && e.code === 'Space') {
      e.preventDefault();
      startMenu.toggle();
    } else if (e.altKey && e.code === 'KeyW' && wm.focusedId) {
      e.preventDefault();
      wm.close(wm.focusedId);
    } else if (e.altKey && e.code === 'KeyM' && wm.focusedId) {
      e.preventDefault();
      wm.minimize(wm.focusedId);
    } else if (e.altKey && e.code === 'ArrowUp' && wm.focusedId) {
      e.preventDefault();
      wm.toggleMaximize(wm.focusedId);
    } else if (e.altKey && e.code === 'KeyD') {
      e.preventDefault();
      wm.toggleDesktop();
    } else if (e.ctrlKey && e.altKey && e.code === 'KeyL') {
      e.preventDefault();
      flyouts.close();
      power.lock();
    }
  });
  // The OS provides its own context menus; inputs and editable areas keep the browser's.
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('input, textarea, [contenteditable], .allow-native-menu')) e.preventDefault();
  });
}

runBoot(init)
  .then(({ firstVisit }) => { if (firstVisit) entry.welcome(); })
  .catch((err) => {
    // Last resort: never leave the splash covering the page.
    console.error(err);
    document.body.classList.remove('booting');
    document.getElementById('boot')?.remove();
  });

// Debug handle for the browser console.
window.ltf = { wm, store, registry, taskbar, desktop, wallpaper };
