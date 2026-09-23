import { chromium } from 'playwright';
import fs from 'fs';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await p.goto('file://' + process.cwd() + '/scene.html');
await p.addScriptTag({ path: 'node_modules/webm-muxer/build/webm-muxer.js' });
const out = await p.evaluate(async () => {
  const FPS = 30, T = 16, N = FPS * T;
  const c = document.getElementById('c');
  const muxer = new WebMMuxer.Muxer({ target: new WebMMuxer.ArrayBufferTarget(), video: { codec: 'V_VP9', width: 1920, height: 1080, frameRate: FPS } });
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { throw e; } });
  const cfg = { codec: 'vp09.00.40.08', width: 1920, height: 1080, bitrate: 2_000_000, bitrateMode: 'constant', framerate: FPS };
  const sup = await VideoEncoder.isConfigSupported(cfg);
  if (!sup.supported) return 'unsupported';
  enc.configure(cfg);
  for (let i = 0; i < N; i++) {
    drawAt((i / FPS) % T);
    const f = new VideoFrame(c, { timestamp: Math.round((i * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
    enc.encode(f, { keyFrame: i % (FPS * 2) === 0 });
    f.close();
    while (enc.encodeQueueSize > 4) await new Promise(r => setTimeout(r, 5));
  }
  await enc.flush();
  muxer.finalize();
  const buf = new Uint8Array(muxer.target.buffer);
  let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
});
if (out === 'unsupported') { console.log('unsupported'); process.exit(1); }
fs.writeFileSync('aurora.webm', Buffer.from(out, 'base64'));
console.log('bytes', fs.statSync('aurora.webm').size);
await b.close();
