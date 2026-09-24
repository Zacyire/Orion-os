// LTF OS — frontend entry point.
import { runBoot } from './core/boot.js';
import { store } from './core/store.js';
import { registry } from './core/registry.js';
import { connectEvents } from './core/api.js';
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

async function init() {
  await store.load();
  initTheme();
  await registry.load();
  wm.init();
  taskbar.init();
  startMenu.init();
  desktop.init();
  widgets.init();
  await wallpaper.init();
  connectEvents();
  bindShortcuts();
  registerServiceWorker();
  initAppBridge(); // window.ltf bridge for first-party app frames
}

/** static/sw.js: /net/ resource caching + offline shell. Never blocks boot. */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
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

runBoot(init).catch((err) => {
  console.error(err);
  document.body.classList.remove('booting');
  document.getElementById('boot')?.remove();
});

// Debug handle for the browser console.
window.ltf = { wm, store, registry, taskbar, desktop, wallpaper };
