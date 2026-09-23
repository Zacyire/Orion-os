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
import { widgets } from './core/widgets.js';
import { wallpaper } from './core/wallpaper.js';
import { flyouts } from './core/flyouts.js';
import { power } from './core/power.js';
import { system } from './core/system.js';

async function init() {
  await store.load();
  initTheme();
  await registry.load();
  wm.init();
  taskbar.init();
  startMenu.init();
  desktop.init();
  widgets.init();
  wallpaper.init();
  connectEvents();
  if (system.toggles.night) document.documentElement.classList.add('night-light');
  bindShortcuts();
}

function bindShortcuts() {
  window.addEventListener('keydown', (e) => {
    if (document.body.classList.contains('booting')) return;
    // Start menu: Ctrl+Space (the OS usually swallows the Windows key).
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
    } else if (e.ctrlKey && e.altKey && e.code === 'KeyT') {
      e.preventDefault();
      wm.open('terminal');
    } else if (e.ctrlKey && e.altKey && e.code === 'KeyL') {
      e.preventDefault();
      flyouts.close();
      power.lock();
    }
  });
  // Suppress the browser context menu on the shell; apps/inputs keep theirs.
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('input, textarea, [contenteditable], .allow-native-menu')) e.preventDefault();
  });
}

runBoot(init).catch((err) => {
  console.error(err);
  document.body.classList.remove('booting');
  document.getElementById('boot')?.remove();
});

// Handy for debugging from the console.
window.ltf = { wm, store, registry, taskbar, desktop };
