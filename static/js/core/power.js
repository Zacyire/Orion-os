// Lock / restart / shut down.
import { h, $ } from './dom.js';
import { store } from './store.js';
import { avatar } from './user.js';

export const power = {
  lock() {
    const time = h('div.lock-time');
    const date = h('div.lock-date');
    const tick = () => {
      const d = new Date();
      time.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      date.textContent = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    };
    tick();
    const timer = setInterval(tick, 1000);
    const screen = h('section#lock-screen', { tabindex: 0 },
      time, date,
      h('div.lock-user', avatar(), h('b', store.get('user.name') || 'User'), h('small', 'Click or press any key to unlock')),
    );
    const unlock = () => {
      screen.classList.add('unlocking');
      clearInterval(timer);
      window.removeEventListener('keydown', unlock);
      setTimeout(() => screen.remove(), 500);
    };
    screen.addEventListener('click', unlock);
    window.addEventListener('keydown', unlock);
    document.body.append(screen);
    screen.focus();
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
