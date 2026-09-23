// Shared shell for the bundled HTML5 games: HUD, start/pause/game-over
// overlay, high score (localStorage) and viewport scaling.
export function run(Game, id) {
  const canvas = document.getElementById('game');
  const score = document.getElementById('score');
  const best = document.getElementById('best');
  const overlay = document.getElementById('overlay');
  const key = `ltf-game-best:${id}`;
  const getBest = () => { try { return +localStorage.getItem(key) || 0; } catch { return 0; } };
  const setBest = (v) => { try { localStorage.setItem(key, v); } catch { /* storage unavailable */ } };
  best.textContent = getBest();

  const game = new Game(canvas, {
    onScore: (s) => (score.textContent = s),
    onOver: (s) => {
      const record = s > getBest();
      if (record) setBest(s);
      best.textContent = getBest();
      show(game.won === undefined ? 'Game over' : game.won ? 'You win' : 'You lose', `Score ${s}${record ? ' · New best' : ''}`, 'Play again', start);
    },
  });
  document.title = Game.title;
  document.getElementById('title').textContent = Game.title;
  document.getElementById('help').textContent = Game.help;
  game.reset();
  game.draw();

  function show(title, sub, label, action) {
    overlay.hidden = false;
    overlay.innerHTML = '';
    const h = document.createElement('h1'); h.textContent = title;
    const p = document.createElement('p'); p.textContent = sub;
    const b = document.createElement('button'); b.textContent = label; b.onclick = action;
    overlay.append(h, p, b);
    b.focus();
  }
  function start() { overlay.hidden = true; game.start(); }
  function resume() { overlay.hidden = true; game.resume(); }
  function pause() { if (!game.running) return; game.pause(); show('Paused', '', 'Resume', resume); }

  canvas.addEventListener('keydown', (e) => {
    if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') game.running ? pause() : !game.over && resume();
  });
  canvas.addEventListener('pointerdown', () => canvas.focus());
  window.addEventListener('blur', pause);

  const fit = () => {
    const r = Math.min((innerWidth - 24) / canvas.width, (innerHeight - 96) / canvas.height, 2);
    canvas.style.width = `${canvas.width * r}px`;
    canvas.style.height = `${canvas.height * r}px`;
  };
  addEventListener('resize', fit);
  fit();
  show(Game.title, Game.help, 'Start', start);
}
