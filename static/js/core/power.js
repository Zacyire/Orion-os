// Lock / restart / shut down.
import { h, $ } from './dom.js';
import { store } from './store.js';
import { entry } from './entry.js';

export const power = {
  /** Local screen lock (presentation only — see core/entry.js). */
  lock() {
    return entry.lock();
  },

  async restart() {
    await this._powerScreen('Restarting…');
    location.reload();
  },

  async shutdown() {
    await this._powerScreen('Shutting down…');
    const scr = $('#power-screen');
    $('#power-text').textContent = 'Session ended. You can close this tab.';
    scr.querySelector('.power-spinner').hidden = true;
    const btn = h('button.btn.primary', { onclick: () => location.reload() }, 'Power on');
    scr.append(btn);
  },

  async _powerScreen(text) {
    await store.flush();
    $('#power-text').textContent = text;
    $('#power-screen').hidden = false;
    await new Promise((r) => setTimeout(r, 1600));
  },
};
