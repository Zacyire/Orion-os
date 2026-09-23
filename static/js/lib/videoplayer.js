// Reusable HTML5 video player with custom controls.
//   const p = createVideoPlayer({ source: { type: 'video'|'hls'|'embed', src }, title, poster, startAt, onProgress, onClose, onEnded });
//   container.append(p.el); … p.destroy();
// HLS streams use native playback where available (Safari) and otherwise
// lazy-load hls.js from jsDelivr. Embed sources render in an AppFrame.
import { h, formatTime, syncRange } from '../core/dom.js';
import { icons } from '../core/icons.js';
import { system } from '../core/system.js';
import { bus } from '../core/events.js';
import { createFrame } from '../core/frame.js';

const HLS_URL = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.mjs';

export function createVideoPlayer({ source, title = '', poster, startAt = 0, onProgress, onClose, onEnded, accent }) {
  const closeBtn = onClose ? h('button.vp-close', { html: icons.arrowLeft, title: 'Back', onclick: () => onClose() }) : null;

  if (source?.type === 'embed') {
    const frame = createFrame({ slot: 'player.embed', url: source.src, title, allow: 'autoplay; fullscreen; picture-in-picture; encrypted-media' });
    const el = h('div.vp', frame.el, h('div.vp-top', closeBtn, h('b', title)));
    return { el, destroy: () => frame.destroy(), focus() {} };
  }

  let hls = null;
  let hideTimer;
  const video = h('video', { playsInline: true, preload: 'metadata', poster: poster || undefined });
  const bigPlay = h('button.vp-big', { html: icons.play, 'aria-label': 'Play' });
  const played = h('div.vp-played');
  const buffered = h('div.vp-buffered');
  const tip = h('div.vp-tip');
  const seek = h('div.vp-seek', h('div.vp-track', buffered, played), tip);
  const playBtn = h('button.icon-btn', { html: icons.play, title: 'Play (Space)' });
  const backBtn = h('button.icon-btn.vp-skip', { title: 'Back 10 s (←)' }, h('span', { html: icons.undo }), h('small', '10'));
  const fwdBtn = h('button.icon-btn.vp-skip', { title: 'Forward 10 s (→)' }, h('span', { html: icons.refresh }), h('small', '10'));
  const muteBtn = h('button.icon-btn', { html: icons.volume, title: 'Mute (M)' });
  const vol = h('input', { type: 'range', min: 0, max: 100, value: 100, 'aria-label': 'Volume' });
  const time = h('span.vp-time', '0:00 / 0:00');
  const speed = h('select', { title: 'Playback speed' }, [0.5, 0.75, 1, 1.25, 1.5, 2].map((s) => h('option', { value: s, selected: s === 1 }, `${s}×`)));
  const pipBtn = h('button.icon-btn', { html: icons.pip, title: 'Picture in picture' });
  const fsBtn = h('button.icon-btn', { html: icons.fullscreen, title: 'Fullscreen (F)' });
  const errorEl = h('div.vp-error', { hidden: true });
  const spinner = h('div.vp-spinner', { hidden: true });

  const el = h('div.vp.paused', { tabindex: 0 },
    video, spinner, bigPlay,
    h('div.vp-top', closeBtn, h('b', title)),
    h('div.vp-bottom', seek,
      h('div.vp-row', playBtn, backBtn, fwdBtn, muteBtn, vol, time, h('span.spacer'), speed, pipBtn, fsBtn)),
    errorEl);
  if (accent) el.style.setProperty('--vp-accent', accent);

  let appVol = 100;
  const applyVolume = () => {
    video.volume = (appVol / 100) * system.gain;
    muteBtn.innerHTML = video.volume === 0 ? icons.mute : icons.volume;
  };
  const offVol = bus.on('system:volume', applyVolume);
  applyVolume();
  syncRange(vol);

  async function attach() {
    const src = source?.src;
    if (!src) return fail('No video source configured for this title.');
    if (source.type === 'hls' && !video.canPlayType('application/vnd.apple.mpegurl')) {
      try {
        const { default: Hls } = await import(HLS_URL);
        if (!Hls.isSupported()) return fail('HLS playback is not supported in this browser.');
        hls = new Hls();
        hls.loadSource(src);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) fail(`Stream error: ${d.details}`); });
      } catch {
        return fail('Could not load the HLS player library.');
      }
    } else {
      video.src = src;
    }
    if (startAt > 5) video.addEventListener('loadedmetadata', () => { if (startAt < video.duration - 10) video.currentTime = startAt; }, { once: true });
    video.play().catch(() => {});
  }

  function fail(msg) {
    errorEl.hidden = false;
    errorEl.replaceChildren(h('b', 'Playback error'), h('span', msg));
  }

  const toggle = () => (video.paused ? video.play().catch(() => {}) : video.pause());
  playBtn.addEventListener('click', toggle);
  bigPlay.addEventListener('click', toggle);
  video.addEventListener('click', toggle);
  video.addEventListener('dblclick', () => fsBtn.click());
  backBtn.addEventListener('click', () => (video.currentTime -= 10));
  fwdBtn.addEventListener('click', () => (video.currentTime += 10));
  muteBtn.addEventListener('click', () => { appVol = appVol ? 0 : 100; vol.value = appVol; syncRange(vol); applyVolume(); });
  vol.addEventListener('input', () => { appVol = +vol.value; syncRange(vol); applyVolume(); });
  speed.addEventListener('change', () => (video.playbackRate = +speed.value));
  pipBtn.addEventListener('click', async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch { /* unsupported */ }
  });
  fsBtn.addEventListener('click', () => (document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen?.()));

  const frac = (e) => { const r = seek.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  seek.addEventListener('pointermove', (e) => { const p = frac(e); tip.style.left = `${p * 100}%`; tip.textContent = formatTime(p * (video.duration || 0)); });
  seek.addEventListener('pointerdown', (e) => {
    seek.setPointerCapture(e.pointerId);
    const move = (ev) => { if (video.duration) video.currentTime = frac(ev) * video.duration; };
    move(e);
    seek.addEventListener('pointermove', move);
    seek.addEventListener('pointerup', () => seek.removeEventListener('pointermove', move), { once: true });
  });

  let lastReport = 0;
  const sync = () => {
    const d = video.duration || 0;
    played.style.width = `${d ? (video.currentTime / d) * 100 : 0}%`;
    time.textContent = `${formatTime(video.currentTime)} / ${formatTime(d)}`;
    if (video.buffered.length && d) buffered.style.width = `${(video.buffered.end(video.buffered.length - 1) / d) * 100}%`;
    if (onProgress && d && Math.abs(video.currentTime - lastReport) > 5) {
      lastReport = video.currentTime;
      onProgress(video.currentTime, d);
    }
  };
  video.addEventListener('timeupdate', sync);
  video.addEventListener('progress', sync);
  video.addEventListener('loadedmetadata', sync);
  video.addEventListener('waiting', () => (spinner.hidden = false));
  video.addEventListener('playing', () => (spinner.hidden = true));
  video.addEventListener('play', () => { el.classList.remove('paused'); playBtn.innerHTML = icons.pause; });
  video.addEventListener('pause', () => { el.classList.add('paused'); playBtn.innerHTML = icons.play; onProgress?.(video.currentTime, video.duration || 0); });
  video.addEventListener('ended', () => { onProgress?.(video.duration, video.duration); onEnded?.(); });
  video.addEventListener('error', () => fail('This video could not be loaded. The source may be unavailable, blocked by the network, or in an unsupported format.'));
  el.addEventListener('pointermove', () => {
    el.classList.add('show-ui');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => el.classList.remove('show-ui'), 2500);
  });
  el.addEventListener('keydown', (e) => {
    if (e.target.closest('select, input')) return;
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'k') { e.preventDefault(); toggle(); }
    else if (k === 'arrowleft') video.currentTime -= 5;
    else if (k === 'arrowright') video.currentTime += 5;
    else if (k === 'f') fsBtn.click();
    else if (k === 'm') muteBtn.click();
    else if (k === 'escape' && onClose && !document.fullscreenElement) onClose();
  });

  attach();
  return {
    el,
    video,
    focus: () => el.focus(),
    destroy() {
      clearTimeout(hideTimer);
      offVol();
      hls?.destroy();
      video.pause();
      video.removeAttribute('src');
      video.load();
      el.remove();
    },
  };
}
