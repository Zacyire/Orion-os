// Arcade — retro canvas games hub with high scores.
import { h, fill, local } from '../core/dom.js';
import { icons } from '../core/icons.js';
import { GAMES } from '../lib/games.js';

const META = {
  snake: { colors: ['#00f0ff', '#7c5cff'], emoji: '🐍', tag: 'Classic' },
  blocks: { colors: ['#ffd319', '#ff3cac'], emoji: '🧱', tag: 'Puzzle' },
  pong: { colors: ['#3ddc97', '#1793d1'], emoji: '🏓', tag: 'Versus CPU' },
};

export default {
  single: true,

  mount(root, ctx) {
    let game = null;
    const app = h('div.app');
    root.append(app);

    const best = (id) => local.get(`arcade:best:${id}`, 0);

    function hub() {
      game?.destroy();
      game = null;
      ctx.win.setTitle('Arcade');
      app.replaceChildren(h('div.gm-hub',
        h('h1.page-title', 'Arcade'),
        h('p.muted', { style: { marginTop: '-10px' } }, 'Pick a game. Click the game area to focus it for keyboard input.'),
        h('div.gm-grid', Object.entries(GAMES).map(([id, G]) => {
          const m = META[id];
          const cover = h('div.gm-cover', { style: { background: `radial-gradient(circle at 30% 30%, ${m.colors[0]}, transparent 60%), radial-gradient(circle at 80% 80%, ${m.colors[1]}, transparent 60%), #0b0b16`, display: 'grid', placeItems: 'center', fontSize: '64px' } }, m.emoji);
          const card = h('button.gm-card', cover, h('div', h('b', G.title), h('small', `${m.tag} · Best: ${best(id)}`)));
          card.addEventListener('click', () => play(id));
          return card;
        })),
      ));
    }

    function play(id) {
      const G = GAMES[id];
      const canvas = h('canvas');
      const score = h('span.gm-score', 'Score 0');
      const bestEl = h('span.gm-score', { style: { color: '#888' } }, `Best ${best(id)}`);
      const overlay = h('div.gm-overlay');
      const pauseBtn = h('button.btn', { html: icons.pause, title: 'Pause (P)' });
      const wrap = h('div.gm-canvas-wrap', canvas, overlay);
      app.replaceChildren(h('div.gm-play',
        h('header',
          h('button.btn.ghost', { onclick: hub, html: icons.chevronLeft }, 'Games'),
          h('b', G.title), h('span.spacer'), score, bestEl, pauseBtn,
          h('button.btn', { onclick: () => start(), html: icons.restart, title: 'Restart' }),
        ),
        wrap,
        h('div.gm-help', G.help, ' · P to pause'),
      ));
      ctx.win.setTitle(`${G.title} — Arcade`);

      game = new G(canvas, {
        onScore: (s) => (score.textContent = `Score ${s}`),
        onOver: (s) => {
          const prev = best(id);
          if (s > prev) local.set(`arcade:best:${id}`, s);
          bestEl.textContent = `Best ${Math.max(prev, s)}`;
          showOverlay(game.won === undefined ? 'GAME OVER' : game.won ? 'YOU WIN' : 'CPU WINS', `Score ${s}${s > prev ? ' — new high score!' : ''}`, 'Play again', start);
        },
      });
      game.reset();
      game.draw();

      function showOverlay(title, sub, label, action) {
        overlay.hidden = false;
        fill(overlay, h('h2', title), sub ? h('div', sub) : null, h('button.btn.primary', { onclick: action }, label));
      }
      function start() {
        overlay.hidden = true;
        game.start();
        pauseBtn.innerHTML = icons.pause;
      }
      function resume() {
        overlay.hidden = true;
        game.resume();
        pauseBtn.innerHTML = icons.pause;
      }
      function pause() {
        if (!game.running) return;
        game.pause();
        pauseBtn.innerHTML = icons.play;
        showOverlay('PAUSED', '', 'Resume', resume);
      }
      pauseBtn.addEventListener('click', () => (game.running ? pause() : game.over ? start() : resume()));
      canvas.addEventListener('keydown', (e) => { if (e.key === 'p' || e.key === 'Escape') game.running ? pause() : resume(); });
      canvas.addEventListener('click', () => canvas.focus());
      showOverlay(G.title.toUpperCase(), G.help, 'Start', start);
    }

    hub();
    return {
      onFocus() { app.querySelector('canvas')?.focus(); },
      destroy() { game?.destroy(); },
    };
  },
};
