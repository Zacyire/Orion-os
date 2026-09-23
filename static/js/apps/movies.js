// Cinema — video player with custom controls, playlist, speed, PiP,
// fullscreen and local file playback.
import { h, formatTime, syncRange, local } from '../core/dom.js';
import { icons } from '../core/icons.js';
import { system } from '../core/system.js';

export default {
  single: true,

  async mount(root, ctx) {
    let videos = [];
    try {
      videos = await ctx.api.get('/media/videos');
    } catch {
      videos = [];
    }
    let index = -1;
    let hideTimer;
    let appVol = local.get('movies:vol', 90);

    const video = h('video', { playsinline: true, preload: 'metadata' });
    const titleEl = h('div.mv-title');
    const bigPlay = h('button.mv-big-play', { html: icons.play, 'aria-label': 'Play' });
    const played = h('div.played');
    const buffered = h('div.buffered');
    const tip = h('div.tip');
    const seek = h('div.mv-seek', h('div.track', buffered, played), tip);
    const playBtn = h('button.icon-btn', { html: icons.play, title: 'Play (Space)' });
    const back = h('button.icon-btn', { html: icons.undo, title: 'Back 10s (←)' });
    const fwd = h('button.icon-btn', { html: icons.refresh, title: 'Forward 10s (→)' });
    const nextBtn = h('button.icon-btn', { html: icons.next, title: 'Next' });
    const muteBtn = h('button.icon-btn', { html: icons.volume, title: 'Mute (M)' });
    const vol = h('input', { type: 'range', min: 0, max: 100, value: appVol, 'aria-label': 'Volume' });
    const time = h('span', '0:00 / 0:00');
    const speed = h('select', { title: 'Playback speed' }, [0.5, 0.75, 1, 1.25, 1.5, 2].map((s) => h('option', { value: s, selected: s === 1 }, `${s}×`)));
    const pipBtn = h('button.icon-btn', { html: icons.pip, title: 'Picture in picture' });
    const listBtn = h('button.icon-btn', { html: icons.list, title: 'Toggle playlist' });
    const fsBtn = h('button.icon-btn', { html: icons.fullscreen, title: 'Fullscreen (F)' });
    const errorEl = h('div.mv-error', { hidden: true });

    const stage = h('div.mv-stage.paused', video, titleEl, bigPlay,
      h('div.mv-overlay', h('div.mv-controls', seek,
        h('div.mv-row', playBtn, back, fwd, nextBtn, muteBtn, vol, time, h('span.spacer'), speed, pipBtn, listBtn, fsBtn))),
      errorEl);
    const fileInput = h('input', { type: 'file', accept: 'video/*', hidden: true });
    const listEl = h('div.mv-list');
    const mv = h('div.mv', stage, listEl);
    root.append(h('div.app', mv), fileInput);

    const applyVolume = () => { video.volume = (appVol / 100) * system.gain; muteBtn.innerHTML = video.volume === 0 ? icons.mute : icons.volume; };
    const offVol = ctx.bus.on('system:volume', applyVolume);
    applyVolume();
    syncRange(vol);

    function renderList() {
      listEl.replaceChildren(
        h('h3', 'Up next', h('button.btn', { onclick: () => fileInput.click(), style: { height: '26px' } }, h('span', { html: icons.open }), 'Open file')),
        ...(videos.length ? [] : [h('p', { style: { color: '#888', fontSize: '12px', padding: '0 4px' } }, 'Kernel offline — open a local video file instead.')]),
        ...videos.map((v, i) => {
          const b = h(`button.mv-item${i === index ? '.active' : ''}`,
            v.poster ? h('img', { src: v.poster, alt: '', loading: 'lazy', onerror: (e) => e.target.replaceWith(h('div.ph')) }) : h('div.ph'),
            h('div', h('b', v.title), h('small', `${v.year} · ${v.genre} · ${v.duration}`)),
          );
          b.addEventListener('click', () => load(i, true));
          return b;
        }),
      );
    }

    function load(i, autoplay) {
      index = i;
      const v = videos[i];
      errorEl.hidden = true;
      video.src = v.src;
      if (v.poster) video.poster = v.poster;
      titleEl.textContent = v.title;
      ctx.win.setTitle(`${v.title} — Cinema`);
      renderList();
      if (autoplay) video.play().catch(() => {});
    }

    fileInput.addEventListener('change', () => {
      const f = fileInput.files[0];
      if (!f) return;
      const v = { id: `local-${Date.now()}`, title: f.name, year: 'Local', genre: 'File', duration: '—', src: URL.createObjectURL(f) };
      videos.unshift(v);
      load(0, true);
    });

    const toggle = () => (video.paused ? video.play().catch(() => {}) : video.pause());
    playBtn.addEventListener('click', toggle);
    bigPlay.addEventListener('click', toggle);
    video.addEventListener('click', toggle);
    video.addEventListener('dblclick', () => fsBtn.click());
    back.addEventListener('click', () => (video.currentTime -= 10));
    fwd.addEventListener('click', () => (video.currentTime += 10));
    nextBtn.addEventListener('click', () => videos.length && load((index + 1) % videos.length, true));
    muteBtn.addEventListener('click', () => { appVol = appVol ? 0 : 80; vol.value = appVol; syncRange(vol); applyVolume(); });
    vol.addEventListener('input', () => { appVol = +vol.value; local.set('movies:vol', appVol); syncRange(vol); applyVolume(); });
    speed.addEventListener('change', () => (video.playbackRate = +speed.value));
    pipBtn.addEventListener('click', async () => {
      try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else await video.requestPictureInPicture();
      } catch (e) { ctx.notify('Picture-in-picture unavailable', e.message, { type: 'error' }); }
    });
    listBtn.addEventListener('click', () => mv.classList.toggle('no-list'));
    fsBtn.addEventListener('click', () => (document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen?.()));

    const seekTo = (e) => {
      const r = seek.getBoundingClientRect();
      return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    };
    seek.addEventListener('pointermove', (e) => {
      const p = seekTo(e);
      tip.style.left = `${p * 100}%`;
      tip.textContent = formatTime(p * (video.duration || 0));
    });
    seek.addEventListener('pointerdown', (e) => {
      seek.setPointerCapture(e.pointerId);
      const move = (ev) => { if (video.duration) video.currentTime = seekTo(ev) * video.duration; };
      move(e);
      seek.addEventListener('pointermove', move);
      seek.addEventListener('pointerup', () => seek.removeEventListener('pointermove', move), { once: true });
    });

    const sync = () => {
      const d = video.duration || 0;
      played.style.width = `${d ? (video.currentTime / d) * 100 : 0}%`;
      time.textContent = `${formatTime(video.currentTime)} / ${formatTime(d)}`;
      if (video.buffered.length && d) buffered.style.width = `${(video.buffered.end(video.buffered.length - 1) / d) * 100}%`;
    };
    video.addEventListener('timeupdate', sync);
    video.addEventListener('progress', sync);
    video.addEventListener('loadedmetadata', sync);
    video.addEventListener('play', () => { stage.classList.remove('paused'); playBtn.innerHTML = icons.pause; });
    video.addEventListener('pause', () => { stage.classList.add('paused'); playBtn.innerHTML = icons.play; });
    video.addEventListener('ended', () => videos.length > 1 && load((index + 1) % videos.length, true));
    video.addEventListener('error', () => {
      errorEl.hidden = false;
      errorEl.replaceChildren(
        h('b', 'This video could not be loaded.'),
        h('span', { style: { color: '#aaa' } }, 'The sample stream may be blocked by your network. Try opening a local file.'),
        h('div', h('button.btn.primary', { onclick: () => fileInput.click() }, 'Open local file')),
      );
    });
    stage.addEventListener('pointermove', () => {
      stage.classList.add('show-ui');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => stage.classList.remove('show-ui'), 2200);
    });

    const onKey = (e) => {
      if (!ctx.win.isFocused() || e.target.closest('input, select, textarea')) return;
      const k = e.key.toLowerCase();
      if (k === ' ' || k === 'k') { e.preventDefault(); toggle(); }
      else if (k === 'arrowleft') video.currentTime -= 5;
      else if (k === 'arrowright') video.currentTime += 5;
      else if (k === 'f') fsBtn.click();
      else if (k === 'm') muteBtn.click();
    };
    window.addEventListener('keydown', onKey);

    renderList();
    if (videos.length) load(0, false);
    else titleEl.textContent = 'Open a video to start watching';

    return () => {
      video.pause();
      video.removeAttribute('src');
      video.load();
      offVol();
      window.removeEventListener('keydown', onKey);
      clearTimeout(hideTimer);
    };
  },
};
