// Spiceify — music player. Library: content/music.json.
//   tracks → played with <audio>; a Web Audio analyser drives the visualizer
//            when the source is same-origin or CORS-enabled.
//   embeds → streaming-service players (Spotify, SoundCloud, …) in an AppFrame.
import { h, local, fill, formatTime, syncRange } from '../core/dom.js';
import { icons } from '../core/icons.js';
import { system } from '../core/system.js';
import { createFrame } from '../core/frame.js';

export default {
  single: true,

  async mount(root, ctx) {
    const doc = await ctx.api.content('music');
    const tracks = doc.tracks || [];
    const embeds = doc.embeds || [];
    let liked = new Set(local.get('spice:liked', []));
    let queue = tracks.slice();
    let index = -1;
    let shuffle = local.get('spice:shuffle', false);
    let repeat = local.get('spice:repeat', 'off'); // off | all | one
    let appVol = local.get('spice:vol', 80);
    let viewName = 'home';
    let embedFrame = null;
    const durations = local.get('spice:durations', {});

    // ── audio ──
    // A fresh <audio> per track: only same-origin / CORS-enabled sources are
    // routed through the Web Audio analyser (cross-origin media without CORS
    // would otherwise play silently once connected to the graph).
    let audio = new Audio();
    let actx = null;
    let analyser = null;
    let vizEnabled = false;

    const applyVolume = () => (audio.volume = (appVol / 100) * system.gain);
    const offVol = ctx.bus.on('system:volume', applyVolume);
    applyVolume();

    // ── layout ──
    const sideNav = h('nav.sp-nav');
    const lists = h('div.sp-lists');
    const main = h('div.sp-main');
    const viz = h('canvas.sp-viz');
    const art = h('div.sp-now-art');
    const nowText = h('div.sp-now-text');
    const likeBtn = h('button.icon-btn.sp-like', { html: icons.heart, title: 'Save to Liked Songs' });
    const playBtn = h('button.sp-play', { html: icons.play, 'aria-label': 'Play' });
    const prevBtn = h('button.icon-btn', { html: icons.prev, title: 'Previous' });
    const nextBtn = h('button.icon-btn', { html: icons.next, title: 'Next' });
    const shufBtn = h('button.icon-btn', { html: icons.shuffle, title: 'Shuffle' });
    const repBtn = h('button.icon-btn', { html: icons.repeat, title: 'Repeat' });
    const seek = h('input', { type: 'range', min: 0, max: 1000, value: 0, 'aria-label': 'Seek' });
    const cur = h('span', '0:00');
    const dur = h('span', '0:00');
    const vol = h('input', { type: 'range', min: 0, max: 100, value: appVol, 'aria-label': 'Volume' });
    syncRange(vol);

    root.append(h('div.app.sp',
      h('aside.sp-side', h('div.sp-brand', h('span', { html: icons.music }), 'Spiceify'), sideNav, h('div.sp-lib-title', 'Your Library'), lists),
      h('div.sp-center', viz, main),
      h('footer.sp-bar',
        h('div.sp-now', art, nowText, likeBtn),
        h('div.sp-controls',
          h('div.sp-buttons', shufBtn, prevBtn, playBtn, nextBtn, repBtn),
          h('div.sp-progress', cur, seek, dur),
        ),
        h('div.sp-vol', h('span', { html: icons.volume }), vol),
      ),
    ));

    const artStyle = (t) => {
      const [a, b] = t?.colors || ['#1db954', '#0b3d24'];
      return t?.cover ? `url("${t.cover}") center / cover` : `linear-gradient(135deg, ${a}, ${b})`;
    };
    const artEl = (t, cls = 'sp-art') => h(`div.${cls}`, { style: { background: artStyle(t) } }, t?.cover ? null : h('span', { html: icons.music }));

    function navItem(id, icon, label) {
      const b = h(`button.sp-nav-item${viewName === id ? '.active' : ''}`, { html: icons[icon] }, label);
      b.addEventListener('click', () => show(id));
      return b;
    }

    function renderSide() {
      sideNav.replaceChildren(navItem('home', 'home', 'Home'), navItem('search', 'search', 'Search'));
      lists.replaceChildren(
        libItem('liked', h('div.sp-art.liked', { html: icons.heart }), 'Liked Songs', `${liked.size} songs`),
        libItem('all', artEl(tracks[0]), 'All tracks', `${tracks.length} songs`),
        ...embeds.map((e) => libItem(`embed:${e.id}`, h('div.sp-art.embed', { html: icons.globe }), e.title, e.provider || 'Embed')),
      );
    }

    function libItem(id, artNode, title, sub) {
      const b = h(`button.sp-lib-item${viewName === id ? '.active' : ''}`, artNode, h('div', h('b', title), h('small', sub)));
      b.addEventListener('click', () => show(id));
      return b;
    }

    function trackTable(list) {
      if (!list.length) return h('div.sp-empty', 'No tracks here yet.');
      return h('div.sp-table',
        h('div.sp-tr.head', h('span', '#'), h('span', 'Title'), h('span', 'Album'), h('span', { html: icons.clock })),
        ...list.map((t, i) => {
          const playing = queue[index]?.id === t.id;
          const r = h(`button.sp-tr${playing ? '.playing' : ''}`,
            h('span.sp-num', playing && !audio.paused ? h('span.sp-eq', h('i'), h('i'), h('i')) : String(i + 1)),
            h('span.sp-title', artEl(t, 'sp-art-sm'), h('div', h('b', t.title), h('small', t.artist))),
            h('span.sp-album', t.album || ''),
            h('span.sp-dur', durations[t.id] ? formatTime(durations[t.id]) : '—'),
          );
          r.addEventListener('click', () => { queue = list.slice(); playIndex(i); });
          return r;
        }));
    }

    function playlistHeader(title, sub, t, kind = 'Playlist') {
      const [a] = t?.colors || ['#1db954'];
      return h('header.sp-header', { style: { '--sp-h': a } },
        h('div.sp-header-art', { style: { background: artStyle(t) } }),
        h('div', h('small', kind), h('h1', title), h('p', sub),
          h('button.sp-play.big', { html: icons.play, title: 'Play', onclick: () => { queue = currentList(); playIndex(0); } })),
      );
    }

    const currentList = () => (viewName === 'liked' ? tracks.filter((t) => liked.has(t.id)) : tracks);

    function show(id) {
      viewName = id;
      embedFrame?.destroy();
      embedFrame = null;
      renderSide();
      if (id.startsWith('embed:')) {
        const e = embeds.find((x) => `embed:${x.id}` === id);
        // CREATOR SLOT: streaming-service player (content/music.json → embeds[].url)
        embedFrame = createFrame({
          slot: `spiceify.embed.${e.id}`, url: e.url, title: e.title,
          allow: 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture',
        });
        embedFrame.el.classList.add('sp-embed');
        return fill(main, h('div.sp-embed-wrap', h('div.sp-embed-head', h('h2', e.title), h('small', e.provider || '')), embedFrame.el));
      }
      if (id === 'search') {
        const input = h('input.sp-search', { type: 'search', placeholder: 'What do you want to play?' });
        const results = h('div');
        const run = () => {
          const q = input.value.trim().toLowerCase();
          const hits = q ? tracks.filter((t) => `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q)) : [];
          fill(results, q ? trackTable(hits) : h('div.sp-empty', 'Search your library by title, artist or album.'));
        };
        input.addEventListener('input', run);
        fill(main, h('div.sp-pad', input, results));
        run();
        return setTimeout(() => input.focus(), 30);
      }
      if (id === 'liked') return fill(main, playlistHeader('Liked Songs', `${liked.size} songs`, { colors: ['#5038a0', '#1e1450'] }), h('div.sp-pad', trackTable(currentList())));
      if (id === 'all') return fill(main, playlistHeader('All tracks', `${tracks.length} songs`, tracks[0]), h('div.sp-pad', trackTable(tracks)));
      // home
      const hour = new Date().getHours();
      fill(main, h('div.sp-pad',
        h('h1.sp-greet', hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'),
        h('div.sp-tiles', ...[
          ['liked', 'Liked Songs', h('div.sp-art.liked', { html: icons.heart })],
          ['all', 'All tracks', artEl(tracks[0])],
          ...embeds.map((e) => [`embed:${e.id}`, e.title, h('div.sp-art.embed', { html: icons.globe })]),
        ].map(([vid, label, a]) => h('button.sp-tile', { onclick: () => show(vid) }, a, h('b', label)))),
        h('h2', 'Tracks'),
        h('div.sp-cards', tracks.map((t, i) => h('button.sp-card', { onclick: () => { queue = tracks.slice(); playIndex(i); } },
          artEl(t, 'sp-card-art'), h('b', t.title), h('small', t.artist)))),
        !tracks.length && !embeds.length ? h('div.sp-empty', 'Your library is empty. Add tracks or embeds to content/music.json.') : null,
      ));
    }

    // ── playback ──
    function load(t) {
      audio.pause();
      audio.removeAttribute('src');
      audio = new Audio();
      audio.preload = 'auto';
      const corsOk = new URL(t.src, location.href).origin === location.origin || t.cors === true;
      vizEnabled = false;
      if (corsOk) {
        audio.crossOrigin = 'anonymous';
        try {
          actx ||= new (window.AudioContext || window.webkitAudioContext)();
          analyser ||= Object.assign(actx.createAnalyser(), { fftSize: 256 });
          analyser.connect(actx.destination);
          actx.createMediaElementSource(audio).connect(analyser);
          vizEnabled = true;
        } catch { /* Web Audio unavailable — play without visualizer */ }
      }
      bindAudio(audio);
      applyVolume();
      audio.src = t.src;
    }

    function playIndex(i) {
      if (!queue.length) return;
      index = (i + queue.length) % queue.length;
      const t = queue[index];
      load(t);
      actx?.resume();
      audio.play().catch((e) => ctx.notify('Playback failed', e.message, { type: 'error' }));
      renderNow();
      show(viewName.startsWith('embed:') ? 'home' : viewName);
    }

    function renderNow() {
      const t = queue[index];
      art.style.background = artStyle(t);
      art.innerHTML = t?.cover ? '' : icons.music;
      nowText.replaceChildren(h('b', t?.title || 'Nothing playing'), h('small', t?.artist || ''));
      likeBtn.classList.toggle('on', !!t && liked.has(t.id));
      playBtn.innerHTML = audio.paused ? icons.play : icons.pause;
      shufBtn.classList.toggle('on', shuffle);
      repBtn.classList.toggle('on', repeat !== 'off');
      repBtn.title = `Repeat: ${repeat}`;
      ctx.win.setTitle(t ? `${t.title} · ${t.artist} — Spiceify` : 'Spiceify');
    }

    function next(auto = false) {
      if (auto && repeat === 'one') return playIndex(index);
      if (shuffle && queue.length > 1) {
        let j;
        do j = Math.floor(Math.random() * queue.length); while (j === index);
        return playIndex(j);
      }
      if (auto && repeat === 'off' && index === queue.length - 1) { renderNow(); return; }
      playIndex(index + 1);
    }

    playBtn.addEventListener('click', () => {
      if (index < 0) return playIndex(0);
      actx?.resume();
      audio.paused ? audio.play() : audio.pause();
    });
    prevBtn.addEventListener('click', () => (audio.currentTime > 3 ? (audio.currentTime = 0) : playIndex(index - 1)));
    nextBtn.addEventListener('click', () => next());
    shufBtn.addEventListener('click', () => { shuffle = !shuffle; local.set('spice:shuffle', shuffle); renderNow(); });
    repBtn.addEventListener('click', () => { repeat = { off: 'all', all: 'one', one: 'off' }[repeat]; local.set('spice:repeat', repeat); renderNow(); });
    likeBtn.addEventListener('click', () => {
      const t = queue[index];
      if (!t) return;
      liked.has(t.id) ? liked.delete(t.id) : liked.add(t.id);
      local.set('spice:liked', [...liked]);
      renderNow();
      renderSide();
    });
    let seeking = false;
    seek.addEventListener('input', () => { seeking = true; syncRange(seek); cur.textContent = formatTime((seek.value / 1000) * (audio.duration || 0)); });
    seek.addEventListener('change', () => { if (audio.duration) audio.currentTime = (seek.value / 1000) * audio.duration; seeking = false; });
    vol.addEventListener('input', () => { appVol = +vol.value; local.set('spice:vol', appVol); syncRange(vol); applyVolume(); });

    function bindAudio(audio) {
      audio.addEventListener('play', () => { renderNow(); if (!viewName.startsWith('embed:') && viewName !== 'search') show(viewName); });
      audio.addEventListener('pause', renderNow);
      audio.addEventListener('ended', () => next(true));
      audio.addEventListener('loadedmetadata', () => {
        const t = queue[index];
        if (t) { durations[t.id] = audio.duration; local.set('spice:durations', durations); }
        dur.textContent = formatTime(audio.duration);
      });
      audio.addEventListener('timeupdate', () => {
        if (seeking) return;
        seek.value = audio.duration ? (audio.currentTime / audio.duration) * 1000 : 0;
        syncRange(seek);
        cur.textContent = formatTime(audio.currentTime);
      });
      audio.addEventListener('error', () => {
        const t = queue[index];
        ctx.notify('Track unavailable', t ? `${t.title} could not be loaded.` : '', { type: 'error' });
      });
    }

    // ── visualizer ──
    const vctx = viz.getContext('2d');
    let raf = 0;
    let bins;
    function draw() {
      raf = requestAnimationFrame(draw);
      const W = viz.clientWidth, H = viz.clientHeight;
      if (!W) return;
      const dpr = Math.min(devicePixelRatio || 1, 2);
      if (viz.width !== Math.round(W * dpr)) { viz.width = W * dpr; viz.height = H * dpr; }
      vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      vctx.clearRect(0, 0, W, H);
      if (!vizEnabled || !analyser || audio.paused) return;
      bins ||= new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(bins);
      const [c] = queue[index]?.colors || ['#1db954'];
      const n = 64, bw = W / n;
      vctx.fillStyle = c;
      vctx.globalAlpha = 0.22;
      for (let i = 0; i < n; i++) {
        const v = bins[Math.floor((i / n) * bins.length * 0.8)] / 255;
        vctx.fillRect(i * bw + 1, H - v * H * 0.5, bw - 2, v * H * 0.5);
      }
      vctx.globalAlpha = 1;
    }
    draw();

    const onKey = (e) => {
      if (!ctx.win.isFocused() || e.target.closest('input, textarea')) return;
      if (e.code === 'Space') { e.preventDefault(); playBtn.click(); }
    };
    window.addEventListener('keydown', onKey);

    // Preload durations so the table can show them.
    tracks.filter((t) => !durations[t.id]).slice(0, 12).forEach((t) => {
      const probe = new Audio();
      probe.preload = 'metadata';
      probe.addEventListener('loadedmetadata', () => { durations[t.id] = probe.duration; local.set('spice:durations', durations); if (viewName === 'all' || viewName === 'liked') show(viewName); }, { once: true });
      probe.src = t.src;
    });

    renderNow();
    show('home');
    return {
      destroy() {
        cancelAnimationFrame(raf);
        window.removeEventListener('keydown', onKey);
        offVol();
        audio.pause();
        audio.removeAttribute('src');
        actx?.close();
        embedFrame?.destroy();
      },
    };
  },
};
