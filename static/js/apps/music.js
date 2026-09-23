// Groove — music player with procedural tracks and a canvas visualizer.
import { h, formatTime, syncRange, local } from '../core/dom.js';
import { icons } from '../core/icons.js';
import { system } from '../core/system.js';
import { SynthEngine, albumArt } from '../lib/synth.js';

const FALLBACK_TRACKS = [
  { id: 't1', title: 'Low Taper Fade', artist: 'Ninja & The Barbers', album: 'Imagine If', bpm: 112, root: 45, scale: 'minor', wave: 'sawtooth', colors: ['#ff3cac', '#784ba0', '#2b86c5'] },
  { id: 't3', title: 'Arch Btw', artist: 'Pacman Syndicate', album: 'Rolling Release', bpm: 96, root: 50, scale: 'pentatonic', wave: 'triangle', colors: ['#1793d1', '#0f2027', '#2c5364'] },
];
const VIZ = ['bars', 'radial', 'wave'];

export default {
  single: true,

  async mount(root, ctx) {
    const engine = new SynthEngine();
    let tracks = [];
    let index = 0;
    let shuffle = local.get('music:shuffle', false);
    let repeat = local.get('music:repeat', 'all'); // all | one | off
    let appVol = local.get('music:vol', 80);
    let vizMode = local.get('music:viz', 'bars');
    let raf = 0;
    let seeking = false;

    try {
      tracks = await ctx.api.get('/media/tracks');
    } catch {
      tracks = FALLBACK_TRACKS;
    }

    const list = h('div.mu-list');
    const viz = h('canvas.mu-viz');
    const art = h('img.mu-art', { alt: '' });
    const title = h('h2');
    const artist = h('p');
    const stage = h('div.mu-stage', viz, art, h('div.mu-meta', title, artist));
    const vizBtn = h('button.btn.ghost.mu-viz-mode', { title: 'Visualizer style' });
    stage.append(vizBtn);

    const playBtn = h('button.mu-play', { 'aria-label': 'Play' });
    const prevBtn = h('button.icon-btn', { html: icons.prev, title: 'Previous' });
    const nextBtn = h('button.icon-btn', { html: icons.next, title: 'Next' });
    const shufBtn = h('button.icon-btn', { html: icons.shuffle, title: 'Shuffle' });
    const repBtn = h('button.icon-btn', { html: icons.repeat, title: 'Repeat' });
    const seek = h('input', { type: 'range', min: 0, max: 1000, value: 0, 'aria-label': 'Seek' });
    const cur = h('span', '0:00');
    const dur = h('span', '0:00');
    const vol = h('input', { type: 'range', min: 0, max: 100, value: appVol, 'aria-label': 'Volume' });
    const nowArt = h('img.mu-art-sm', { alt: '' });
    const nowText = h('div');

    const mu = h('div.mu',
      list, stage,
      h('div.mu-bar',
        h('div.mu-now', nowArt, nowText),
        h('div.mu-controls',
          h('div.mu-buttons', shufBtn, prevBtn, playBtn, nextBtn, repBtn),
          h('div.mu-progress', cur, seek, dur),
        ),
        h('div.mu-vol', h('span', { html: icons.volume, style: { width: '18px' } }), vol),
      ),
    );
    root.append(h('div.app', mu));

    const applyVolume = () => engine.setVolume((appVol / 100) * system.gain);
    const offVol = ctx.bus.on('system:volume', applyVolume);

    function renderList() {
      list.replaceChildren(h('div.muted', { style: { padding: '4px 10px 10px', fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: '.08em' } }, 'Now playing queue'),
        ...tracks.map((t, i) => {
          const b = h(`button.mu-track${i === index ? '.active' : ''}`,
            h('img.mu-art-sm', { src: albumArt(t, 80), alt: '' }),
            h('div', h('div.mu-t-title', t.title), h('small', `${t.artist} · ${t.bpm} BPM`)),
            h('span.dur', formatTime((48 * 16 * 60) / t.bpm / 4)),
          );
          b.addEventListener('click', () => load(i, true));
          return b;
        }));
    }

    function renderButtons() {
      playBtn.innerHTML = engine.playing ? icons.pause : icons.play;
      playBtn.setAttribute('aria-label', engine.playing ? 'Pause' : 'Play');
      shufBtn.classList.toggle('on', shuffle);
      repBtn.classList.toggle('on', repeat !== 'off');
      repBtn.title = `Repeat: ${repeat}`;
      repBtn.style.position = 'relative';
      repBtn.dataset.one = repeat === 'one' ? '1' : '';
      repBtn.innerHTML = icons.repeat + (repeat === 'one' ? '<small style="position:absolute;font-size:8px;font-weight:700;right:6px;bottom:4px">1</small>' : '');
      mu.classList.toggle('playing', engine.playing);
      vizBtn.textContent = `✦ ${vizMode}`;
    }

    function load(i, autoplay) {
      index = (i + tracks.length) % tracks.length;
      const t = tracks[index];
      const wasPlaying = engine.playing;
      engine.pause();
      engine.load(t);
      applyVolume();
      art.src = albumArt(t, 480);
      nowArt.src = albumArt(t, 80);
      title.textContent = t.title;
      artist.textContent = `${t.artist} — ${t.album}`;
      nowText.replaceChildren(h('b', t.title), h('small', t.artist));
      mu.style.setProperty('--mu-a', t.colors[0]);
      dur.textContent = formatTime(engine.duration);
      ctx.win.setTitle(`${t.title} · ${t.artist} — Groove`);
      renderList();
      if (autoplay || wasPlaying) engine.play().then(renderButtons);
      renderButtons();
    }

    function next(auto = false) {
      if (auto && repeat === 'one') return load(index, true);
      if (auto && repeat === 'off' && index === tracks.length - 1 && !shuffle) {
        renderButtons();
        return;
      }
      if (shuffle && tracks.length > 1) {
        let j;
        do j = Math.floor(Math.random() * tracks.length); while (j === index);
        return load(j, true);
      }
      load(index + 1, true);
    }

    engine.onEnd = () => next(true);

    playBtn.addEventListener('click', async () => {
      if (engine.playing) engine.pause();
      else await engine.play();
      renderButtons();
    });
    prevBtn.addEventListener('click', () => (engine.position > 3 ? (engine.seek(0), tick()) : load(index - 1, engine.playing)));
    nextBtn.addEventListener('click', () => next());
    shufBtn.addEventListener('click', () => { shuffle = !shuffle; local.set('music:shuffle', shuffle); renderButtons(); });
    repBtn.addEventListener('click', () => { repeat = { all: 'one', one: 'off', off: 'all' }[repeat]; local.set('music:repeat', repeat); renderButtons(); });
    vizBtn.addEventListener('click', () => { vizMode = VIZ[(VIZ.indexOf(vizMode) + 1) % VIZ.length]; local.set('music:viz', vizMode); renderButtons(); });
    seek.addEventListener('input', () => { seeking = true; syncRange(seek); cur.textContent = formatTime((seek.value / 1000) * engine.duration); });
    seek.addEventListener('change', () => { engine.seek((seek.value / 1000) * engine.duration); seeking = false; });
    vol.addEventListener('input', () => { appVol = +vol.value; local.set('music:vol', appVol); syncRange(vol); applyVolume(); });
    syncRange(vol);

    // Space toggles playback when the window is focused.
    const onKey = (e) => {
      if (!ctx.win.isFocused() || e.target.closest('input, textarea')) return;
      if (e.code === 'Space') { e.preventDefault(); playBtn.click(); }
      if (e.code === 'ArrowRight') next();
      if (e.code === 'ArrowLeft') prevBtn.click();
    };
    window.addEventListener('keydown', onKey);

    function tick() {
      if (!seeking) {
        seek.value = engine.duration ? (engine.position / engine.duration) * 1000 : 0;
        syncRange(seek);
        cur.textContent = formatTime(engine.position);
      }
    }

    // ─── visualizer ───
    const vctx = viz.getContext('2d');
    let freq, wave;
    function draw() {
      raf = requestAnimationFrame(draw);
      tick();
      const dpr = Math.min(devicePixelRatio || 1, 2);
      const W = viz.clientWidth;
      const H = viz.clientHeight;
      if (!W || !H) return;
      if (viz.width !== Math.round(W * dpr)) { viz.width = W * dpr; viz.height = H * dpr; }
      vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      vctx.clearRect(0, 0, W, H);
      const an = engine.analyser;
      if (!an) return;
      freq ||= new Uint8Array(an.frequencyBinCount);
      wave ||= new Uint8Array(an.fftSize);
      an.getByteFrequencyData(freq);
      an.getByteTimeDomainData(wave);
      const [c1, c2, c3] = tracks[index].colors;
      const grad = vctx.createLinearGradient(0, H, 0, 0);
      grad.addColorStop(0, c1);
      grad.addColorStop(0.5, c2);
      grad.addColorStop(1, c3);

      if (vizMode === 'bars') {
        const n = 72;
        const bw = W / n;
        vctx.fillStyle = grad;
        vctx.globalAlpha = 0.55;
        for (let i = 0; i < n; i++) {
          const v = freq[Math.floor((i / n) ** 1.6 * freq.length * 0.7)] / 255;
          const bh = v * H * 0.6;
          vctx.fillRect(i * bw + 1, H - bh, bw - 2, bh);
          vctx.globalAlpha = 0.15;
          vctx.fillRect(i * bw + 1, 0, bw - 2, bh * 0.25);
          vctx.globalAlpha = 0.55;
        }
        vctx.globalAlpha = 1;
      } else if (vizMode === 'radial') {
        const cx = W / 2;
        const cy = H / 2 - 30;
        const base = Math.min(W, H) * 0.24;
        const n = 128;
        vctx.lineWidth = 3;
        vctx.strokeStyle = grad;
        vctx.globalAlpha = 0.8;
        for (let i = 0; i < n; i++) {
          const v = freq[Math.floor((i / n) * freq.length * 0.6)] / 255;
          const a = (i / n) * Math.PI * 2 - Math.PI / 2;
          const r2 = base + v * base * 0.9;
          vctx.beginPath();
          vctx.moveTo(cx + Math.cos(a) * base, cy + Math.sin(a) * base);
          vctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
          vctx.stroke();
        }
        vctx.globalAlpha = 1;
      } else {
        vctx.lineWidth = 2.5;
        vctx.strokeStyle = c1;
        vctx.shadowColor = c1;
        vctx.shadowBlur = 12;
        for (const [amp, alpha] of [[1, 1], [0.6, 0.35]]) {
          vctx.globalAlpha = alpha;
          vctx.beginPath();
          for (let i = 0; i < wave.length; i += 4) {
            const x = (i / wave.length) * W;
            const y = H / 2 + ((wave[i] - 128) / 128) * H * 0.4 * amp;
            i ? vctx.lineTo(x, y) : vctx.moveTo(x, y);
          }
          vctx.stroke();
        }
        vctx.shadowBlur = 0;
        vctx.globalAlpha = 1;
      }
    }

    load(0, false);
    draw();

    return {
      onArgs(a) { if (a.track != null) load(+a.track, true); },
      destroy() {
        cancelAnimationFrame(raf);
        window.removeEventListener('keydown', onKey);
        offVol();
        engine.destroy();
      },
    };
  },
};
