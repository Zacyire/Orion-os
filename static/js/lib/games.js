// Lightweight canvas arcade games shared by Arcade and FadeNOW.
// Each game: new Game(canvas, { onScore, onOver }) → start() / pause() / resume() / destroy()

const COLORS = ['#00f0ff', '#7c5cff', '#ff3cac', '#ffd319', '#3ddc97', '#ff7a18', '#1793d1'];

class BaseGame {
  constructor(canvas, hooks = {}) {
    this.c = canvas;
    this.x = canvas.getContext('2d');
    this.hooks = hooks;
    this.score = 0;
    this.running = false;
    this.over = false;
    this.raf = 0;
    this.acc = 0;
    this.last = 0;
    this.keys = new Set();
    this._down = (e) => {
      if (this.handleKey(e) !== false && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'w', 'a', 's', 'd'].includes(e.key)) e.preventDefault();
      this.keys.add(e.key);
    };
    this._up = (e) => this.keys.delete(e.key);
    canvas.tabIndex = 0;
    canvas.addEventListener('keydown', this._down);
    canvas.addEventListener('keyup', this._up);
  }

  start() {
    this.reset();
    this.score = 0;
    this.over = false;
    this.hooks.onScore?.(0);
    this.resume();
  }

  resume() {
    if (this.running || this.over) return;
    this.running = true;
    this.last = performance.now();
    const loop = (t) => {
      if (!this.running) return;
      const dt = Math.min(100, t - this.last);
      this.last = t;
      this.acc += dt;
      while (this.acc >= this.stepMs) {
        this.acc -= this.stepMs;
        this.update();
        if (this.over) break;
      }
      this.draw();
      if (!this.over) this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    this.c.focus();
  }

  pause() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  addScore(n) {
    this.score += n;
    this.hooks.onScore?.(this.score);
  }

  gameOver() {
    this.over = true;
    this.running = false;
    this.draw();
    this.hooks.onOver?.(this.score);
  }

  destroy() {
    this.pause();
    this.c.removeEventListener('keydown', this._down);
    this.c.removeEventListener('keyup', this._up);
  }

  handleKey() {}
}

// ─── Snake ────────────────────────────────────────────────────────────────
export class Snake extends BaseGame {
  static title = 'Neon Snake';
  static help = 'Arrow keys / WASD to steer. Eat the orbs, don’t bite yourself.';
  cols = 28;
  rows = 20;
  cell = 22;

  constructor(canvas, hooks) {
    super(canvas, hooks);
    canvas.width = this.cols * this.cell;
    canvas.height = this.rows * this.cell;
  }

  reset() {
    this.snake = [{ x: 8, y: 10 }, { x: 7, y: 10 }, { x: 6, y: 10 }];
    this.dir = { x: 1, y: 0 };
    this.queue = [];
    this.stepMs = 110;
    this.placeFood();
  }

  placeFood() {
    do {
      this.food = { x: Math.floor(Math.random() * this.cols), y: Math.floor(Math.random() * this.rows) };
    } while (this.snake.some((s) => s.x === this.food.x && s.y === this.food.y));
  }

  handleKey(e) {
    const map = { ArrowUp: [0, -1], w: [0, -1], ArrowDown: [0, 1], s: [0, 1], ArrowLeft: [-1, 0], a: [-1, 0], ArrowRight: [1, 0], d: [1, 0] };
    const d = map[e.key];
    if (!d) return false;
    const last = this.queue.at(-1) || this.dir;
    if (d[0] === -last.x && d[1] === -last.y) return;
    if (this.queue.length < 3) this.queue.push({ x: d[0], y: d[1] });
  }

  update() {
    if (this.queue.length) this.dir = this.queue.shift();
    const head = { x: (this.snake[0].x + this.dir.x + this.cols) % this.cols, y: (this.snake[0].y + this.dir.y + this.rows) % this.rows };
    if (this.snake.some((s) => s.x === head.x && s.y === head.y)) return this.gameOver();
    this.snake.unshift(head);
    if (head.x === this.food.x && head.y === this.food.y) {
      this.addScore(10);
      this.stepMs = Math.max(55, this.stepMs - 2.5);
      this.placeFood();
    } else this.snake.pop();
  }

  draw() {
    const { x, cell } = this;
    x.fillStyle = '#07070f';
    x.fillRect(0, 0, this.c.width, this.c.height);
    x.strokeStyle = 'rgba(124,92,255,.08)';
    for (let i = 0; i <= this.cols; i++) { x.beginPath(); x.moveTo(i * cell, 0); x.lineTo(i * cell, this.c.height); x.stroke(); }
    for (let j = 0; j <= this.rows; j++) { x.beginPath(); x.moveTo(0, j * cell); x.lineTo(this.c.width, j * cell); x.stroke(); }
    x.shadowBlur = 16;
    x.shadowColor = '#ff3cac';
    x.fillStyle = '#ff3cac';
    x.beginPath();
    x.arc(this.food.x * cell + cell / 2, this.food.y * cell + cell / 2, cell / 2.8, 0, Math.PI * 2);
    x.fill();
    x.shadowColor = '#00f0ff';
    this.snake.forEach((s, i) => {
      x.fillStyle = i === 0 ? '#fff' : `hsl(${185 + i * 3}, 100%, ${60 - Math.min(i, 20)}%)`;
      x.fillRect(s.x * cell + 2, s.y * cell + 2, cell - 4, cell - 4);
    });
    x.shadowBlur = 0;
  }
}

// ─── Blocks (Tetris-style) ────────────────────────────────────────────────
const SHAPES = [
  [[1, 1, 1, 1]],
  [[1, 1], [1, 1]],
  [[0, 1, 0], [1, 1, 1]],
  [[1, 0, 0], [1, 1, 1]],
  [[0, 0, 1], [1, 1, 1]],
  [[1, 1, 0], [0, 1, 1]],
  [[0, 1, 1], [1, 1, 0]],
];

export class Blocks extends BaseGame {
  static title = 'Fade Blocks';
  static help = '←/→ move · ↑ rotate · ↓ soft drop · Space hard drop.';
  cols = 10;
  rows = 20;
  cell = 28;

  constructor(canvas, hooks) {
    super(canvas, hooks);
    canvas.width = this.cols * this.cell + 150;
    canvas.height = this.rows * this.cell;
  }

  reset() {
    this.grid = Array.from({ length: this.rows }, () => Array(this.cols).fill(0));
    this.stepMs = 16;
    this.fallEvery = 45;
    this.tick = 0;
    this.lines = 0;
    this.next = this.rand();
    this.spawn();
  }

  rand() {
    const i = Math.floor(Math.random() * SHAPES.length);
    return { m: SHAPES[i].map((r) => r.map((v) => (v ? i + 1 : 0))) };
  }

  spawn() {
    this.p = { ...this.next, x: 3, y: 0 };
    this.next = this.rand();
    if (this.collide(this.p.m, this.p.x, this.p.y)) this.gameOver();
  }

  collide(m, ox, oy) {
    return m.some((row, y) => row.some((v, x) => v && (x + ox < 0 || x + ox >= this.cols || y + oy >= this.rows || (y + oy >= 0 && this.grid[y + oy][x + ox]))));
  }

  rotate(m) {
    return m[0].map((_, i) => m.map((r) => r[i]).reverse());
  }

  handleKey(e) {
    if (this.over || !this.running) return false;
    const p = this.p;
    if (e.key === 'ArrowLeft' && !this.collide(p.m, p.x - 1, p.y)) p.x--;
    else if (e.key === 'ArrowRight' && !this.collide(p.m, p.x + 1, p.y)) p.x++;
    else if (e.key === 'ArrowDown') this.drop();
    else if (e.key === 'ArrowUp') {
      const r = this.rotate(p.m);
      for (const kick of [0, -1, 1, -2, 2]) {
        if (!this.collide(r, p.x + kick, p.y)) { p.m = r; p.x += kick; break; }
      }
    } else if (e.key === ' ') {
      while (!this.collide(p.m, p.x, p.y + 1)) { p.y++; this.addScore(2); }
      this.lock();
    } else return false;
    this.draw();
  }

  drop() {
    if (!this.collide(this.p.m, this.p.x, this.p.y + 1)) this.p.y++;
    else this.lock();
  }

  lock() {
    this.p.m.forEach((row, y) => row.forEach((v, x) => { if (v && y + this.p.y >= 0) this.grid[y + this.p.y][x + this.p.x] = v; }));
    let cleared = 0;
    this.grid = this.grid.filter((r) => !r.every(Boolean) || (cleared++, false));
    while (this.grid.length < this.rows) this.grid.unshift(Array(this.cols).fill(0));
    if (cleared) {
      this.lines += cleared;
      this.addScore([0, 100, 300, 500, 800][cleared]);
      this.fallEvery = Math.max(6, 45 - Math.floor(this.lines / 5) * 4);
    }
    this.spawn();
  }

  update() {
    if (++this.tick >= this.fallEvery) {
      this.tick = 0;
      this.drop();
    }
  }

  block(x, y, v, alpha = 1) {
    const { cell } = this;
    this.x.globalAlpha = alpha;
    this.x.fillStyle = COLORS[(v - 1) % COLORS.length];
    this.x.fillRect(x * cell + 1, y * cell + 1, cell - 2, cell - 2);
    this.x.fillStyle = 'rgba(255,255,255,.25)';
    this.x.fillRect(x * cell + 1, y * cell + 1, cell - 2, 4);
    this.x.globalAlpha = 1;
  }

  draw() {
    const { x, cell } = this;
    const W = this.cols * cell;
    x.fillStyle = '#07070f';
    x.fillRect(0, 0, this.c.width, this.c.height);
    x.fillStyle = '#0e0e1c';
    x.fillRect(0, 0, W, this.c.height);
    this.grid.forEach((row, y) => row.forEach((v, i) => v && this.block(i, y, v)));
    if (this.p) {
      let gy = this.p.y;
      while (!this.collide(this.p.m, this.p.x, gy + 1)) gy++;
      this.p.m.forEach((row, y) => row.forEach((v, i) => v && this.block(i + this.p.x, y + gy, v, 0.2)));
      this.p.m.forEach((row, y) => row.forEach((v, i) => v && this.block(i + this.p.x, y + this.p.y, v)));
    }
    x.fillStyle = '#aaa';
    x.font = '600 13px system-ui';
    x.fillText('NEXT', W + 20, 30);
    this.next.m.forEach((row, y) => row.forEach((v, i) => {
      if (!v) return;
      x.fillStyle = COLORS[(v - 1) % COLORS.length];
      x.fillRect(W + 20 + i * 22, 45 + y * 22, 20, 20);
    }));
    x.fillStyle = '#aaa';
    x.fillText('LINES', W + 20, 140);
    x.fillStyle = '#fff';
    x.font = '700 22px system-ui';
    x.fillText(String(this.lines ?? 0), W + 20, 166);
  }
}

// ─── Pong ─────────────────────────────────────────────────────────────────
export class Pong extends BaseGame {
  static title = 'Taper Pong';
  static help = 'W/S or ↑/↓ to move. First to 7 wins. Beat the CPU!';

  constructor(canvas, hooks) {
    super(canvas, hooks);
    canvas.width = 640;
    canvas.height = 400;
  }

  reset() {
    this.stepMs = 1000 / 120;
    this.p1 = { y: 160, s: 0 };
    this.p2 = { y: 160, s: 0 };
    this.serve(1);
  }

  serve(dir) {
    this.ball = { x: 320, y: 200, vx: 3.2 * dir, vy: (Math.random() * 2 - 1) * 2.4 };
  }

  update() {
    const up = this.keys.has('ArrowUp') || this.keys.has('w');
    const dn = this.keys.has('ArrowDown') || this.keys.has('s');
    this.p1.y = Math.max(0, Math.min(320, this.p1.y + (dn - up) * 5));
    // CPU: tracks the ball with a capped speed + slight lag
    const target = this.ball.y - 40;
    this.p2.y += Math.max(-3.6, Math.min(3.6, (target - this.p2.y) * 0.09));
    const b = this.ball;
    b.x += b.vx;
    b.y += b.vy;
    if (b.y < 6 || b.y > 394) b.vy *= -1;
    const hit = (py, px, side) => b.y > py && b.y < py + 80 && (side < 0 ? b.x < px + 12 && b.x > px : b.x > px - 12 && b.x < px);
    if (b.vx < 0 && hit(this.p1.y, 20, -1)) {
      b.vx = -b.vx * 1.06;
      b.vy += ((b.y - (this.p1.y + 40)) / 40) * 2.5;
      this.addScore(1);
    }
    if (b.vx > 0 && hit(this.p2.y, 620, 1)) {
      b.vx = -b.vx * 1.04;
      b.vy += ((b.y - (this.p2.y + 40)) / 40) * 2;
    }
    if (b.x < -10) { this.p2.s++; this.serve(1); }
    if (b.x > 650) { this.p1.s++; this.addScore(10); this.serve(-1); }
    if (this.p1.s >= 7 || this.p2.s >= 7) {
      this.won = this.p1.s >= 7;
      this.gameOver();
    }
  }

  draw() {
    const { x } = this;
    x.fillStyle = '#07070f';
    x.fillRect(0, 0, 640, 400);
    x.setLineDash([8, 10]);
    x.strokeStyle = 'rgba(255,255,255,.15)';
    x.beginPath(); x.moveTo(320, 0); x.lineTo(320, 400); x.stroke();
    x.setLineDash([]);
    x.font = '700 42px ui-monospace, monospace';
    x.fillStyle = 'rgba(255,255,255,.3)';
    x.textAlign = 'center';
    x.fillText(this.p1.s, 260, 60);
    x.fillText(this.p2.s, 380, 60);
    x.textAlign = 'start';
    x.shadowBlur = 18;
    x.shadowColor = '#00f0ff';
    x.fillStyle = '#00f0ff';
    x.fillRect(12, this.p1.y, 10, 80);
    x.shadowColor = '#ff3cac';
    x.fillStyle = '#ff3cac';
    x.fillRect(618, this.p2.y, 10, 80);
    x.shadowColor = '#fff';
    x.fillStyle = '#fff';
    x.beginPath(); x.arc(this.ball.x, this.ball.y, 7, 0, Math.PI * 2); x.fill();
    x.shadowBlur = 0;
  }
}

export const GAMES = { snake: Snake, blocks: Blocks, pong: Pong };
