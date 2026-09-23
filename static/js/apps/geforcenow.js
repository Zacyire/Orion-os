// GeForce NOW — cloud gaming frame.
//
// The streaming portal itself is embedded in an AppFrame (URL from
// static/apps.json → geforcenow.embed.url). Around it this app provides a
// launcher with real connection diagnostics: round-trip latency to the LTF
// server, browser network information, connected gamepads (Gamepad API) and
// playback capabilities (WebRTC, fullscreen, pointer lock, H.264/AV1 decode).
// If the portal refuses to be framed, the frame offers "Open in new tab".
import { h, local } from '../core/dom.js';
import { icons, appIcon } from '../core/icons.js';
import { createFrame } from '../core/frame.js';

export default {
  single: true,

  mount(root, ctx) {
    const embed = ctx.app.embed || {};
    const portal = local.get('gfn:url', embed.url || '');
    const history = [];
    let pingTimer = 0;
    let frame = null;

    // ── launcher ──
    const latencyVal = h('b', '—');
    const jitterVal = h('b', '—');
    const spark = h('canvas.gfn-spark', { width: 280, height: 60 });
    const quality = h('span.gfn-quality', 'Measuring…');
    const padsEl = h('div.gfn-pads');
    const capsEl = h('div.gfn-caps');
    const urlInput = h('input.field', { value: portal, placeholder: 'https://play.geforcenow.com/', spellcheck: false });

    const launcher = h('div.gfn-launch',
      h('section.gfn-hero',
        h('div.gfn-hero-icon', appIcon(ctx.app, 'xl')),
        h('div',
          h('h1', 'GeForce NOW'),
          h('p', 'Stream PC games from the cloud. The session opens inside this window with gamepad, fullscreen and keyboard access enabled.'),
          h('div.gfn-actions',
            h('button.gfn-btn', { onclick: () => launch() }, h('span', { html: icons.play }), 'Launch'),
            h('button.gfn-btn.ghost', { onclick: () => window.open(urlInput.value || portal, '_blank', 'noopener') }, h('span', { html: icons.external }), 'Open in browser tab'),
          ),
        ),
      ),
      h('div.gfn-grid',
        h('section.gfn-card',
          h('header', h('span', { html: icons.signal }), 'Connection'),
          h('div.gfn-stat-row', h('div', h('small', 'Round-trip (LTF server)'), latencyVal), h('div', h('small', 'Jitter'), jitterVal)),
          spark,
          quality,
          h('div.gfn-netinfo', netInfo()),
        ),
        h('section.gfn-card',
          h('header', h('span', { html: icons.gamepad }), 'Controllers'),
          padsEl,
          h('small.gfn-hint', 'Press any button on a connected controller to wake it.'),
        ),
        h('section.gfn-card',
          h('header', h('span', { html: icons.cpu }), 'Browser capabilities'),
          capsEl,
        ),
        h('section.gfn-card',
          h('header', h('span', { html: icons.settings }), 'Portal'),
          h('label.gfn-field', h('small', 'Streaming portal URL'), urlInput),
          h('div.gfn-actions', h('button.btn', { onclick: () => { local.set('gfn:url', urlInput.value.trim()); ctx.notify('Portal URL saved'); } }, 'Save'),
            h('button.btn.ghost', { onclick: () => { urlInput.value = embed.url || ''; local.set('gfn:url', urlInput.value); } }, 'Reset')),
          h('small.gfn-hint', 'Default comes from static/apps.json (geforcenow.embed.url).'),
        ),
      ),
    );

    // ── session view ──
    const session = h('div.gfn-session', { hidden: true });
    const app = h('div.app.gfn', launcher, session);
    root.append(app);

    function launch() {
      const url = urlInput.value.trim() || embed.url;
      // CREATOR SLOT: cloud-gaming portal iframe (gamepad / fullscreen / pointer-lock enabled)
      frame?.destroy();
      frame = createFrame({
        slot: 'geforcenow.session',
        title: 'GeForce NOW session',
        allow: embed.allow || 'autoplay; fullscreen; gamepad; keyboard-map; clipboard-read; clipboard-write; microphone; camera',
        check: true,
        allowProxy: false, // WebRTC streaming and sign-in cannot work through a proxy
        placeholder: { title: 'No portal configured', text: 'Set a streaming portal URL in the launcher or in static/apps.json.' },
      });
      const bar = h('div.gfn-session-bar',
        h('button.gfn-bar-btn', { html: icons.arrowLeft, title: 'Back to launcher', onclick: exit }),
        h('span.gfn-live', h('i'), 'Session'),
        h('span.spacer'),
        h('span.gfn-bar-ping', latencyVal.cloneNode(true)),
        h('button.gfn-bar-btn', { html: icons.refresh, title: 'Reload', onclick: () => frame.reload() }),
        h('button.gfn-bar-btn', { html: icons.fullscreen, title: 'Fullscreen', onclick: () => (document.fullscreenElement ? document.exitFullscreen() : session.requestFullscreen?.()) }),
        h('button.gfn-bar-btn', { html: icons.external, title: 'Open in new tab', onclick: () => window.open(url, '_blank', 'noopener') }),
      );
      session.replaceChildren(bar, frame.el);
      launcher.hidden = true;
      session.hidden = false;
      frame.load(url);
      ctx.win.setTitle('GeForce NOW — Session');
    }

    function exit() {
      frame?.destroy();
      frame = null;
      session.hidden = true;
      launcher.hidden = false;
      ctx.win.setTitle('GeForce NOW');
    }

    // ── diagnostics ──
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
      session.querySelector('.gfn-bar-ping b')?.replaceChildren(latencyVal.textContent);
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
    pingTimer = setInterval(measure, 2000);

    return {
      destroy() {
        clearInterval(pingTimer);
        window.removeEventListener('gamepadconnected', onPad);
        window.removeEventListener('gamepaddisconnected', onPad);
        frame?.destroy();
      },
    };
  },
};
