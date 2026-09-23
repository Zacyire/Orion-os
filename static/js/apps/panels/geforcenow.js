// GeForce NOW side panel (opened from the ⓘ title-bar control of the
// GeForce NOW web-app). Real measurements only: round-trip latency and
// jitter to the LTF OS server, browser network information, connected
// controllers (Gamepad API) and decode/streaming capabilities.
import { h, local } from '../../core/dom.js';
import { icons } from '../../core/icons.js';

export function mountPanel(el, ctx) {
  const history = [];
  const latencyVal = h('b', '—');
  const jitterVal = h('b', '—');
  const spark = h('canvas.gfn-spark', { width: 320, height: 60 });
  const quality = h('span.gfn-quality', 'Measuring…');
  const padsEl = h('div.gfn-pads');
  const capsEl = h('div.gfn-caps');
  const urlInput = h('input.field', { value: local.get('gfn:url', ctx.target), spellcheck: false, 'aria-label': 'Portal URL' });

  el.classList.add('gfn-panel');
  el.append(
    h('h2', 'Session details'),
    h('section.gfn-card',
      h('header', h('span', { html: icons.signal }), 'Connection'),
      h('div.gfn-stat-row', h('div', h('small', 'Round-trip (LTF server)'), latencyVal), h('div', h('small', 'Jitter'), jitterVal)),
      spark, quality, h('div.gfn-netinfo', netInfo())),
    h('section.gfn-card', h('header', h('span', { html: icons.gamepad }), 'Controllers'), padsEl,
      h('small.gfn-hint', 'Press any button on a connected controller to wake it.')),
    h('section.gfn-card', h('header', h('span', { html: icons.cpu }), 'Browser capabilities'), capsEl),
    h('section.gfn-card', h('header', h('span', { html: icons.settings }), 'Portal'),
      h('label.gfn-field', h('small', 'Streaming portal URL'), urlInput),
      h('div.gfn-actions',
        h('button.btn.primary', { onclick: () => { local.set('gfn:url', urlInput.value.trim()); ctx.load(urlInput.value.trim()); } }, 'Load'),
        h('button.btn', { onclick: () => { urlInput.value = ctx.target; local.set('gfn:url', ctx.target); ctx.load(ctx.target); } }, 'Reset')),
      h('small.gfn-hint', 'Default: static/apps.json → geforcenow.target')),
  );

  async function measure() {
    try {
      const t0 = performance.now();
      await fetch('/api/ping', { cache: 'no-store' });
      history.push(performance.now() - t0);
    } catch {
      history.push(NaN);
    }
    if (history.length > 40) history.shift();
    const ok = history.filter(Number.isFinite);
    const last = ok.at(-1);
    latencyVal.textContent = Number.isFinite(history.at(-1)) ? `${Math.round(last)} ms` : 'unreachable';
    if (ok.length > 2) {
      const diffs = ok.slice(1).map((v, i) => Math.abs(v - ok[i]));
      const jitter = diffs.reduce((a, b) => a + b, 0) / diffs.length;
      jitterVal.textContent = `${jitter.toFixed(1)} ms`;
      const avg = ok.reduce((a, b) => a + b, 0) / ok.length;
      quality.textContent = avg < 40 && jitter < 10 ? 'Excellent for competitive play' : avg < 80 ? 'Good for most games' : 'High latency — expect input delay';
      quality.dataset.level = avg < 40 && jitter < 10 ? 'good' : avg < 80 ? 'ok' : 'bad';
    }
    drawSpark(ok);
  }

  function drawSpark(data) {
    const c = spark.getContext('2d');
    const W = spark.width, H = spark.height;
    c.clearRect(0, 0, W, H);
    if (data.length < 2) return;
    const max = Math.max(50, ...data) * 1.2;
    c.strokeStyle = '#76b900';
    c.lineWidth = 2;
    c.beginPath();
    data.forEach((v, i) => {
      const x = (i / (data.length - 1)) * W;
      const y = H - (v / max) * H;
      i ? c.lineTo(x, y) : c.moveTo(x, y);
    });
    c.stroke();
    c.lineTo(W, H); c.lineTo(0, H);
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, 'rgba(118,185,0,.35)'); g.addColorStop(1, 'rgba(118,185,0,0)');
    c.fillStyle = g;
    c.fill();
  }

  function netInfo() {
    const n = navigator.connection;
    if (!n) return h('small.gfn-hint', 'Network Information API not available in this browser.');
    return h('dl', h('dt', 'Type'), h('dd', (n.effectiveType || '—').toUpperCase()), h('dt', 'Downlink'), h('dd', n.downlink ? `${n.downlink} Mb/s` : '—'), h('dt', 'Network RTT'), h('dd', n.rtt ? `${n.rtt} ms` : '—'));
  }

  function renderPads() {
    const pads = [...(navigator.getGamepads?.() || [])].filter(Boolean);
    padsEl.replaceChildren(...(pads.length
      ? pads.map((p) => h('div.gfn-pad', h('span', { html: icons.gamepad }), h('div', h('b', p.id.replace(/\(.*?\)/g, '').trim() || 'Gamepad'), h('small', `${p.mapping || 'non-standard'} mapping · ${p.buttons.length} buttons`))))
      : [h('div.gfn-empty', 'No controllers detected')]));
  }

  async function renderCaps() {
    const yes = (v) => h('span', { class: v ? 'ok' : 'no', html: v ? icons.check : icons.close });
    const decode = async (contentType) => {
      try {
        const r = await navigator.mediaCapabilities?.decodingInfo({ type: 'media-source', video: { contentType, width: 1920, height: 1080, bitrate: 20e6, framerate: 60 } });
        return !!r?.supported;
      } catch { return false; }
    };
    const caps = [
      ['WebRTC', 'RTCPeerConnection' in window],
      ['Gamepad API', 'getGamepads' in navigator],
      ['Fullscreen', !!document.fullscreenEnabled],
      ['Pointer lock', 'requestPointerLock' in Element.prototype],
      ['H.264 1080p60 decode', await decode('video/mp4; codecs="avc1.640028"')],
      ['AV1 1080p60 decode', await decode('video/mp4; codecs="av01.0.08M.08"')],
    ];
    capsEl.replaceChildren(...caps.map(([label, v]) => h('div.gfn-cap', yes(v), label)));
  }

  const onPad = () => renderPads();
  window.addEventListener('gamepadconnected', onPad);
  window.addEventListener('gamepaddisconnected', onPad);
  renderPads();
  renderCaps();
  measure();
  const timer = setInterval(measure, 2000);
  return {
    destroy() {
      clearInterval(timer);
      window.removeEventListener('gamepadconnected', onPad);
      window.removeEventListener('gamepaddisconnected', onPad);
    },
  };
}
