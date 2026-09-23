// FadeNOW — GeForce NOW–style cloud gaming portal. Games "stream" from a
// simulated RTX rig: a real canvas game runs in the embedded frame while the
// HUD reports latency / bitrate / packet loss from the chosen region.
import { h, fill, local } from '../core/dom.js';
import { icons } from '../core/icons.js';
import { GAMES } from '../lib/games.js';

const FALLBACK_GAMES = [
  { id: 'g1', title: 'Cyber Taper 2077', genre: 'RPG', rating: 4.6, players: '1', tier: 'Ultimate', colors: ['#fcee0a', '#00f0ff'], embed: 'snake' },
  { id: 'g2', title: 'Fadenite', genre: 'Battle Royale', rating: 4.4, players: '1-100', tier: 'Free', colors: ['#7b2ff7', '#f107a3'], embed: 'pong' },
  { id: 'g3', title: 'Arch of Empires', genre: 'Strategy', rating: 4.7, players: '1-8', tier: 'Priority', colors: ['#1793d1', '#0a2540'], embed: 'blocks' },
];
const FALLBACK_SERVERS = [
  { region: 'US East', ping: 22, load: 40, gpu: 'RTX 4080 SuperPOD' },
  { region: 'EU Central', ping: 91, load: 62, gpu: 'RTX 4080 SuperPOD' },
];
const QUALITY = { '720p60': [720, 60, 15], '1080p120': [1080, 120, 35], '1440p120': [1440, 120, 50], '4K120': [2160, 120, 75] };

export default {
  single: true,
  theme: 'cloud',
  size: [1100, 680],

  async mount(root, ctx) {
    const { api } = ctx;
    let games = await api.get('/cloud/games').catch(() => FALLBACK_GAMES);
    let servers = await api.get('/cloud/servers').catch(() => FALLBACK_SERVERS);
    let region = local.get('cloud:region', servers[0]?.region);
    let quality = local.get('cloud:quality', '1080p120');
    let tab = 'home';
    let recent = local.get('cloud:recent', []);
    let session = null; // { game, instance, timers }
    const pingHist = Array(40).fill(0);

    const server = () => servers.find((s) => s.region === region) || servers[0];

    // ─── top bar ───
    const latCanvas = h('canvas', { width: 160, height: 44 });
    const latDot = h('span.cg-dot');
    const latText = h('span', '-- ms');
    const nav = h('div.cg-nav');
    const body = h('div.cg-body');
    const shell = h('div.cg',
      h('header.cg-top',
        h('div.cg-brand', h('span', { html: icons.cloud, style: { width: '22px', color: '#76b900' } }), 'FADE', h('i', 'NOW')),
        nav, h('span.spacer'),
        h('div.cg-latency', { title: 'Round-trip latency to your streaming rig' }, latDot, latText, latCanvas),
        h('span.chip', { style: { background: '#1b2a05', color: '#9be22d' } }, 'ULTIMATE'),
      ),
      body,
    );
    root.append(shell);

    // Live latency widget: jitter around the region's base ping.
    const latTimer = setInterval(() => {
      const base = server()?.ping ?? 30;
      const p = Math.max(4, Math.round(base + (Math.random() - 0.4) * base * 0.25 + (Math.random() < 0.05 ? base * 0.8 : 0)));
      pingHist.push(p);
      pingHist.shift();
      latText.textContent = `${p} ms`;
      latDot.className = `cg-dot${p > 80 ? ' bad' : p > 40 ? ' mid' : ''}`;
      const x = latCanvas.getContext('2d');
      x.clearRect(0, 0, 160, 44);
      x.strokeStyle = p > 80 ? '#ff5f6d' : p > 40 ? '#ffc857' : '#76b900';
      x.lineWidth = 2;
      x.beginPath();
      const max = Math.max(60, ...pingHist);
      pingHist.forEach((v, i) => {
        const px = (i / (pingHist.length - 1)) * 160;
        const py = 42 - (v / max) * 38;
        i ? x.lineTo(px, py) : x.moveTo(px, py);
      });
      x.stroke();
      session?.onPing?.(p);
    }, 500);

    function artStyle(g) {
      const [a, b] = g.colors;
      return `background: radial-gradient(circle at 20% 15%, ${a}, transparent 55%), radial-gradient(circle at 90% 90%, ${b}, transparent 60%), linear-gradient(160deg, #111, #000);`;
    }

    function card(g) {
      const el = h('button.cg-card',
        h('div.art', { style: artStyle(g) },
          h('div', { style: { position: 'absolute', inset: '30% 10% auto', font: '900 28px/1 system-ui', letterSpacing: '-1px', textTransform: 'uppercase', color: 'rgba(255,255,255,.9)', textShadow: '0 4px 20px rgba(0,0,0,.6)' } }, g.title)),
        h(`span.cg-tier.${g.tier}`, g.tier),
        h('div.info', h('b', g.title), h('small', `${g.genre} · ★ ${g.rating} · ${g.players}P`)),
      );
      el.addEventListener('click', () => launch(g));
      return el;
    }

    function drawNav() {
      nav.replaceChildren(...[['home', 'Home'], ['library', 'Library'], ['settings', 'Servers']].map(([id, label]) => {
        const b = h(`button${tab === id ? '.active' : ''}`, label);
        b.addEventListener('click', () => { tab = id; draw(); });
        return b;
      }));
    }

    let heroRaf = 0;
    function hero(g) {
      const c = h('canvas');
      const el = h('section.cg-hero', c,
        h('div',
          h('span.cg-tier.Ultimate', { style: { position: 'static', display: 'inline-block', marginBottom: '10px' } }, 'Featured · RTX ON'),
          h('h1', g.title),
          h('p', `Stream ${g.title} in up to ${quality} with ray tracing on a ${server()?.gpu || 'RTX'} rig in ${region}. No downloads, no installs.`),
          h('div', { style: { display: 'flex', gap: '10px' } },
            h('button.cg-btn', { onclick: () => launch(g), html: icons.play }, 'Play'),
            h('button.cg-btn.ghost', { onclick: () => { tab = 'settings'; draw(); } }, 'Server: ', region),
          ),
        ),
      );
      // animated light streaks
      const x = c.getContext('2d');
      let t = 0;
      cancelAnimationFrame(heroRaf);
      const loop = () => {
        if (!c.isConnected) return;
        const W = (c.width = c.clientWidth);
        const H = (c.height = c.clientHeight);
        t += 0.01;
        const gr = x.createLinearGradient(0, 0, W, H);
        gr.addColorStop(0, g.colors[1]);
        gr.addColorStop(1, '#000');
        x.fillStyle = gr;
        x.fillRect(0, 0, W, H);
        for (let i = 0; i < 26; i++) {
          const y = ((i * 97 + t * 120 * (1 + (i % 3))) % (H + 200)) - 100;
          x.strokeStyle = i % 2 ? `${g.colors[0]}88` : 'rgba(118,185,0,.5)';
          x.lineWidth = 1 + (i % 4);
          x.beginPath();
          x.moveTo(W * 0.35 + i * 30, y);
          x.lineTo(W * 0.35 + i * 30 + 200, y - 120);
          x.stroke();
        }
        heroRaf = requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
      return el;
    }

    function drawServers() {
      const list = h('div.cg-servers', servers.map((s) => {
        const b = h(`button.cg-server${s.region === region ? '.active' : ''}`,
          h('b', s.region),
          h('span', { style: { color: s.ping > 80 ? '#ff5f6d' : s.ping > 40 ? '#ffc857' : '#9be22d' } }, `${s.ping} ms`),
          h('div.w-bar', h('i', { style: { width: `${s.load}%` } })),
          h('small', { style: { color: '#888' } }, `${s.load}% load`),
        );
        b.addEventListener('click', () => { region = s.region; local.set('cloud:region', region); draw(); });
        return b;
      }));
      const q = h('select.field', { style: { maxWidth: '240px', background: '#15171a' } }, Object.keys(QUALITY).map((k) => h('option', { value: k, selected: k === quality }, k)));
      q.addEventListener('change', () => { quality = q.value; local.set('cloud:quality', quality); });
      return h('div.cg-row',
        h('h3', 'Streaming quality'), q,
        h('h3', 'Server region', h('button.cg-btn.ghost', { style: { marginLeft: '12px', padding: '4px 10px' }, onclick: async () => { servers = await api.get('/cloud/servers').catch(() => servers); draw(); } }, 'Re-test')),
        list,
        h('p', { style: { color: '#777', fontSize: '12px', maxWidth: '560px' } }, 'Latency under 40 ms is recommended for competitive play. The latency widget in the top bar updates live.'),
      );
    }

    function draw() {
      drawNav();
      if (tab === 'settings') return body.replaceChildren(drawServers());
      if (tab === 'library') {
        const mine = games.filter((g) => recent.includes(g.id));
        return body.replaceChildren(h('div.cg-row', h('h3', 'My library'), mine.length ? h('div.cg-cards', mine.map(card)) : h('p', { style: { color: '#777' } }, 'Games you play will show up here.')));
      }
      const rec = recent.map((id) => games.find((g) => g.id === id)).filter(Boolean);
      fill(body,
        hero(games[0]),
        rec.length ? h('div.cg-row', h('h3', 'Continue playing'), h('div.cg-cards', rec.map(card))) : null,
        h('div.cg-row', h('h3', 'Popular on FadeNOW'), h('div.cg-cards', [...games].sort((a, b) => b.rating - a.rating).map(card))),
        h('div.cg-row', h('h3', 'Free to play'), h('div.cg-cards', games.filter((g) => g.tier === 'Free').map(card))),
      );
    }

    async function launch(g) {
      recent = [g.id, ...recent.filter((id) => id !== g.id)].slice(0, 6);
      local.set('cloud:recent', recent);
      const status = h('div', { style: { color: '#aaa' } }, 'Finding an available rig…');
      const queue = h('div.cg-queue', h('div.ring'), h('h2', { style: { margin: 0 } }, g.title), status,
        h('button.cg-btn.ghost', { onclick: () => { queue.remove(); cancelled = true; } }, 'Cancel'));
      let cancelled = false;
      shell.append(queue);
      const steps = [`Position in queue: 3`, `Position in queue: 1`, `Allocating ${server()?.gpu} in ${region}…`, 'Starting stream (AV1)…'];
      for (const s of steps) {
        if (cancelled) return;
        status.textContent = s;
        await new Promise((r) => setTimeout(r, 650));
      }
      if (cancelled) return;
      const info = await api.post('/cloud/session', { game: g.title, region }).catch(() => ({ session_id: 'fn-offline', codec: 'AV1', bitrate_mbps: 50 }));
      queue.remove();
      stream(g, info);
    }

    function stream(g, info) {
      const Game = GAMES[g.embed] || GAMES.snake;
      const canvas = h('canvas');
      const hud = h('div.cg-hud');
      const frame = h('div.frame', canvas, hud);
      const bar = h('div.cg-stream-bar',
        h('b', g.title), h('span', { style: { color: '#777' } }, `Session ${info.session_id} · ${region}`), h('span.spacer'),
        h('span', { style: { color: '#777', fontSize: '12px' } }, Game.help),
        h('button.cg-btn.ghost', { style: { padding: '6px 12px' }, onclick: () => { hud.hidden = !hud.hidden; } }, 'Stats'),
        h('button.cg-btn', { style: { padding: '6px 12px', background: '#e81123', color: '#fff' }, onclick: () => endStream() }, 'Exit game'),
      );
      const view = h('div.cg-stream', frame, bar);
      shell.append(view);

      const [res, fpsTarget, baseRate] = QUALITY[quality];
      const inst = new Game(canvas, {});
      inst.start();
      canvas.addEventListener('click', () => canvas.focus());
      // Games restart automatically in the cloud session.
      inst.hooks.onOver = () => setTimeout(() => session && inst.start(), 1200);

      let frames = 0;
      let fps = 0;
      let lastPing = server()?.ping ?? 30;
      let fpsRaf;
      const count = () => { frames++; fpsRaf = requestAnimationFrame(count); };
      fpsRaf = requestAnimationFrame(count);
      const hudTimer = setInterval(() => {
        fps = frames;
        frames = 0;
        const loss = Math.max(0, (Math.random() - 0.85) * 2).toFixed(2);
        const rate = (baseRate * (0.85 + Math.random() * 0.25)).toFixed(1);
        hud.innerHTML = [
          `${res}p @ ${Math.min(fpsTarget, fps)} fps · ${info.codec || 'AV1'}`,
          `Latency ${lastPing} ms · Decode ${(2 + Math.random() * 2).toFixed(1)} ms`,
          `Bitrate ${rate} Mbps · Packet loss ${loss}%`,
          `Rig ${server()?.gpu} · ${region}`,
        ].join('<br>');
      }, 1000);
      session = { game: g, instance: inst, onPing: (p) => (lastPing = p), stop() { clearInterval(hudTimer); cancelAnimationFrame(fpsRaf); inst.destroy(); view.remove(); } };
      ctx.win.setTitle(`${g.title} — FadeNOW`);
    }

    function endStream() {
      session?.stop();
      session = null;
      ctx.win.setTitle('FadeNOW');
      draw();
    }

    draw();
    return {
      onFocus() { session?.instance.c.focus(); },
      destroy() {
        clearInterval(latTimer);
        cancelAnimationFrame(heroRaf);
        session?.stop();
      },
    };
  },
};
