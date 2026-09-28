// Security boundaries — Vapor prerequisites (Step 21), end to end in Chromium.
//
//   cargo build && node tests/browser/security.browser.mjs
//
// Self-contained: a throwaway Orion OS server (free port, temp data dir; private
// targets allowed only for this instance so a local test site can be framed)
// and a cross-origin local HTML site. Covers:
//   A. /ws Origin enforcement     C. window.ltf caller authentication
//   B. Host-header policy         D. trusted shell modules / local-app fields
// Playwright resolves locally or from `npm root -g` (CHROMIUM_PATH overrides).

import { spawn, execSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) pass++; else fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}${!cond && detail ? ' :: ' + detail : ''}`);
}
async function loadPlaywright() {
  try { const m = await import('playwright'); return m.default ?? m; } catch { /* fall through */ }
  const root = execSync('npm root -g').toString().trim();
  const m = await import(pathToFileURL(path.join(root, 'playwright', 'index.js')).href);
  return m.default ?? m;
}
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
async function waitFor(url, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { try { if ((await fetch(url)).ok) return; } catch { /* not up */ } await new Promise((r) => setTimeout(r, 150)); }
  throw new Error(`timed out waiting for ${url}`);
}
/** Raw GET with an arbitrary Host header (fetch() can't set Host). */
const rawGet = (port, pathname, host) => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port, path: pathname, headers: host === null ? {} : { Host: host }, setHost: host !== null }, (res) => {
    let body = ''; res.on('data', (c) => (body += c)); res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  req.on('error', (e) => resolve({ status: 0, body: e.message }));
  req.end();
});

// Cross-origin "third-party" site.
const site = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><title>third party</title><h1>site</h1>'); });
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${site.address().port}/`;

const bin = process.env.LTF_BIN || path.join(REPO, 'target/debug/ltf-os');
if (!fs.existsSync(bin)) { console.error(`binary not found at ${bin} — run \`cargo build\` or set LTF_BIN`); process.exit(2); }
const port = await freePort();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltf-security-test-'));
const server = spawn(bin, [], {
  cwd: REPO,
  env: { ...process.env, PORT: String(port), LTF_DATA_DIR: dataDir, LTF_STATIC_DIR: path.join(REPO, 'static'), LTF_CONTENT_DIR: path.join(REPO, 'content'), LTF_NETCHECK_URL: '', LTF_PROXY_ALLOW_PRIVATE: '1', LTF_RATE_LIMIT: '100000' },
  stdio: 'ignore',
});
const BASE = `http://127.0.0.1:${port}`;

let browser;
async function cleanup() {
  await browser?.close().catch(() => {});
  if (server.exitCode === null) { const done = new Promise((r) => server.once('exit', r)); server.kill(); await Promise.race([done, new Promise((r) => setTimeout(r, 3000))]); }
  site.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

// In-page: try a WebSocket to `url`; resolves 'open' or 'refused'.
const WS_PROBE = `(url) => new Promise((resolve) => {
  let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
  try { const ws = new WebSocket(url); ws.onopen = () => { fin('open'); ws.close(); }; ws.onerror = () => fin('refused'); ws.onclose = () => fin('refused'); }
  catch (e) { fin('refused'); }
  setTimeout(() => fin('timeout'), 4000);
})`;

try {
  await waitFor(`${BASE}/api/ping`);
  const { chromium } = await loadPlaywright();
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  const requested = [];
  page.on('request', (r) => requested.push(r.url()));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.ltf?.wm && window.__ltfBridge, null, { timeout: 15000 });
  // A fresh browser gets the one-time welcome (core/entry.js); enter the desktop.
  { const welcome = await page.waitForSelector('#entry-screen[data-mode="welcome"]', { timeout: 15000 }).catch(() => null);
    if (welcome) { await page.keyboard.press('Enter'); await page.waitForSelector('#entry-screen', { state: 'detached', timeout: 5000 }); } }
  // Toasts expire, so counting them is unreliable; look for a unique title.
  const handshakes = () => page.evaluate(() => window.__ltfBridge.acceptedHandshakes());
  const hasToast = (title) => page.evaluate((t) => [...document.querySelectorAll('.toast')].some((el) => el.textContent.includes(t)), title);

  // ── A. WebSocket Origin ────────────────────────────────────────────────────
  check('A1 shell origin WebSocket opens', (await page.evaluate(`(${WS_PROBE})('ws://' + location.host + '/ws')`)) === 'open');
  const opaqueWs = await page.evaluate(`new Promise((resolve) => {
    const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts');
    f.srcdoc = '<script>(' + (${WS_PROBE}).toString() + ')(' + JSON.stringify('ws://' + location.host + '/ws') + ').then((r) => parent.postMessage({ wsProbe: r }, "*"))<\\/script>';
    addEventListener('message', function h(e) { if (e.data && e.data.wsProbe) { removeEventListener('message', h); f.remove(); resolve(e.data.wsProbe); } });
    document.body.append(f);
  })`);
  check('A2 opaque-origin frame (Origin: null) is refused', opaqueWs === 'refused', opaqueWs);
  const foreign = await ctx.newPage();
  await foreign.goto(SITE);
  const foreignWs = await foreign.evaluate(`(${WS_PROBE})(${JSON.stringify(`ws://127.0.0.1:${port}/ws`)})`);
  check('A3 cross-origin page is refused', foreignWs === 'refused', foreignWs);

  // ── B. Host policy ─────────────────────────────────────────────────────────
  const rebind = await foreign.goto(`http://evil.localhost:${port}/`).then((r) => ({ status: r.status(), body: '' }), (e) => ({ status: 0, body: e.message }));
  check('B1 browser request with an attacker hostname (evil.localhost → loopback) is refused', rebind.status === 403, JSON.stringify(rebind));
  const rebindApi = await foreign.goto(`http://evil.localhost:${port}/api/files`).then((r) => r.status(), () => 0);
  check('B2 … including /api', rebindApi === 403, String(rebindApi));
  await foreign.close();
  const lh = await ctx.newPage();
  const lhStatus = await lh.goto(`http://localhost:${port}/api/ping`).then((r) => r.status(), () => 0);
  await lh.close();
  check('B3 localhost form is accepted', lhStatus === 200, String(lhStatus));
  for (const [host, want] of [[`127.0.0.1:${port}`, 200], [`localhost:${port}`, 200], [`[::1]:${port}`, 200], [`evil.example:${port}`, 403], [`localhost.evil.example:${port}`, 403], [`127.0.0.1.nip.io:${port}`, 403], ['user@localhost', 403], [`localhost:${port}:1`, 403]]) {
    const r = await rawGet(port, '/api/ping', host);
    check(`B4 Host ${host} → ${want}`, r.status === want, `${r.status} ${r.body.slice(0, 40)}`);
  }

  // ── C. Bridge caller authentication ───────────────────────────────────────
  const openPg = async () => {
    const wid = await page.evaluate(async () => (await window.ltf.wm.open('playground')).id);
    const el = await page.waitForSelector(`.window[data-id="${wid}"] iframe`);
    const fr = await el.contentFrame();
    await fr.waitForFunction(() => window.ltf?.app?.id, null, { timeout: 8000 });
    return { wid, fr };
  };
  const close = async (wid) => { await page.evaluate((w) => window.ltf.wm.close(w), wid); await page.waitForTimeout(300); };

  let { wid, fr } = await openPg();
  const legit = await fr.evaluate(async () => {
    await window.ltf.storage.set('sec', 'ok');
    return { id: (await window.ltf.ready()).id, v: await window.ltf.storage.get('sec'), state: await window.ltf.window.getState() };
  });
  check('C1 legitimate first-party app: handshake + storage + window API work', legit.id === 'playground' && legit.v === 'ok' && legit.state.focused === true, JSON.stringify(legit));
  await fr.evaluate(() => window.ltf.notify('sec-C2-legit', 'legit'));
  await page.waitForTimeout(300);
  check('C2 legitimate notify is delivered', await hasToast('sec-C2-legit'));
  check('C3 exactly one live connection for the app', (await page.evaluate(() => window.__ltfBridge.connectionCount())) === 1);

  // Window channel: a registered frame's raw requests are ignored (port only).
  await fr.evaluate(() => {
    parent.postMessage({ source: 'ltf-app', type: 'notify', title: 'sec-C4-raw', body: 'window channel' }, '*');
    parent.postMessage({ source: 'ltf-app', type: 'storage', op: 'set', key: 'raw', value: 'x', rid: 'r1' }, '*');
  });
  await page.waitForTimeout(400);
  check('C4 window-channel requests are ignored even from the registered frame', !(await hasToast('sec-C4-raw')) && (await page.evaluate(() => localStorage.getItem('ltf:appdata:playground:raw'))) === null);

  // Foreign window: same-origin frame that is not a registered app window.
  let hs0 = await handshakes();
  const foreignFrame = await page.evaluate(() => new Promise((resolve) => {
    const f = document.createElement('iframe');
    f.srcdoc = `<script>
      let got = false;
      addEventListener('message', (e) => { if (e.data && e.data.source === 'ltf-host') got = true; });
      parent.postMessage({ source: 'ltf-app', type: 'hello' }, '*');
      parent.postMessage({ source: 'ltf-app', type: 'notify', title: 'sec-C5-foreign', body: 'x' }, '*');
      setTimeout(() => parent.postMessage({ foreignResult: got }, '*'), 600);
    <\/script>`;
    addEventListener('message', function h(e) { if (e.data && 'foreignResult' in e.data) { removeEventListener('message', h); f.remove(); resolve(e.data.foreignResult); } });
    document.body.append(f);
  }));
  check('C5 foreign (unregistered) window gets no connection', foreignFrame === false && !(await hasToast('sec-C5-foreign')) && (await handshakes()) === hs0);

  // Wrong origin: the registered iframe navigated to a cross-origin document
  // (its src attribute is unchanged — exactly what the old src check trusted).
  const navWin = await openPg();
  await page.evaluate(([w, s]) => { document.querySelector(`.window[data-id="${w}"] iframe`).contentWindow.location = s; }, [navWin.wid, SITE]);
  await page.waitForTimeout(800);
  const navFrame = await (await page.$(`.window[data-id="${navWin.wid}"] iframe`)).contentFrame();
  hs0 = await handshakes();
  const navResult = await navFrame.evaluate(() => new Promise((resolve) => {
    let got = false;
    addEventListener('message', (e) => { if (e.data && e.data.source === 'ltf-host') got = true; });
    parent.postMessage({ source: 'ltf-app', type: 'hello' }, '*');
    parent.postMessage({ source: 'ltf-app', type: 'notify', title: 'sec-C6-navigated', body: 'x' }, '*');
    setTimeout(() => resolve({ got, origin: location.origin }), 600);
  }));
  const navSrc = await page.evaluate((w) => document.querySelector(`.window[data-id="${w}"] iframe`).getAttribute('src'), navWin.wid);
  check('C6 navigated frame (src still first-party, real origin foreign) is refused', navResult.got === false && !(await hasToast('sec-C6-navigated')) && (await handshakes()) === hs0 && navSrc.includes('apps/playground'), JSON.stringify({ navResult, navSrc }));
  await close(navWin.wid);

  // Opaque sandbox inside a registered app window: refused until Vapor Phase C.
  // Baseline BEFORE opening: the shim says hello as soon as the frame loads.
  hs0 = await handshakes();
  const opaque = await page.evaluate(async () => {
    const w = window.ltf.registry.get('webplayer'); const prev = { sandbox: w.sandbox, permissions: w.permissions };
    w.sandbox = 'allow-scripts'; w.permissions = ['notifications'];
    const win = await window.ltf.wm.open('webplayer', { url: 'apps/playground/index.html' });
    Object.assign(w, prev);
    return win.id;
  });
  await page.waitForTimeout(1200);
  const opFrame = await (await page.$(`.window[data-id="${opaque}"] iframe`)).contentFrame();
  const opResult = await opFrame.evaluate(async () => {
    const r = await Promise.race([window.ltf.ready().then(() => 'connected'), new Promise((res) => setTimeout(() => res('no port'), 1200))]);
    window.ltf.notify('sec-C7-opaque', 'x');
    return { r, origin: self.origin };
  });
  await page.waitForTimeout(300);
  check('C7 opaque-origin frame in an app window gets no port and no capability', opResult.r === 'no port' && opResult.origin === 'null' && !(await hasToast('sec-C7-opaque')) && (await handshakes()) === hs0, JSON.stringify(opResult));
  await close(opaque);

  // Leak the live port to the top window, then prove it dies with the frame.
  const leak = async (frame) => {
    await page.evaluate(() => { window.__leaked = null; addEventListener('message', function h(e) { if (e.data && e.data.leak) { window.__leaked = e.ports[0]; removeEventListener('message', h); } }); });
    await frame.evaluate(() => new Promise((resolve) => {
      addEventListener('message', function h(e) {
        if (e.data && e.data.type === 'connect' && e.ports[0]) { removeEventListener('message', h); parent.postMessage({ leak: 1 }, location.origin, [e.ports[0]]); resolve(); }
      });
      parent.postMessage({ source: 'ltf-app', type: 'hello' }, '*'); // fresh handshake (replaces the shim's port)
    }));
    await page.waitForFunction(() => !!window.__leaked);
  };
  const leakedNotify = async (title) => { await page.evaluate((t) => window.__leaked.postMessage({ source: 'ltf-app', type: 'notify', title: t, body: 'x' }), title); await page.waitForTimeout(400); return hasToast(title); };
  await leak(fr);
  check('C8 a live port is a working capability (control)', await leakedNotify('sec-C8-live'));
  await close(wid);
  check('C9 destroyed frame: its port can no longer invoke the bridge', !(await leakedNotify('sec-C9-closed')) && (await page.evaluate(() => window.__ltfBridge.connectionCount())) === 0);

  ({ wid, fr } = await openPg());
  await leak(fr);
  await fr.evaluate(() => parent.postMessage({ source: 'ltf-app', type: 'hello' }, '*')); // replacement handshake
  await page.waitForTimeout(300);
  check('C10 replaced connection: the previous port is dead', !(await leakedNotify('sec-C10-replaced')) && (await page.evaluate(() => window.__ltfBridge.connectionCount())) === 1);
  await close(wid);

  // Permissions still enforced host-side; payload can't self-grant or retarget.
  ({ wid, fr } = await openPg());
  await page.evaluate(() => { window.ltf.registry.get('playground').permissions = ['open-external', 'window']; });
  const perm = await fr.evaluate(async () => {
    window.ltf.notify('sec-C11-perm', 'should be blocked');
    const s = await window.ltf.storage.get('x').then(() => 'resolved', (e) => e.message);
    return { s };
  });
  await page.waitForTimeout(400);
  check('C11 permission enforcement unchanged (notify + storage denied without grant)', !(await hasToast('sec-C11-perm')) && /permission denied/.test(perm.s), JSON.stringify(perm));
  await page.evaluate(() => { window.ltf.registry.get('playground').permissions = ['notifications', 'open-external', 'storage', 'window']; });
  await leak(fr);
  await page.evaluate(() => window.__leaked.postMessage({ source: 'ltf-app', type: 'storage', op: 'set', key: 'k', value: 'v', rid: 'x', appId: 'notepad', permissions: ['storage'] }));
  await page.waitForTimeout(300);
  const ns = await page.evaluate(() => ({ own: localStorage.getItem('ltf:appdata:playground:k'), other: localStorage.getItem('ltf:appdata:notepad:k') }));
  check('C12 app id in the payload cannot retarget another app', ns.own === '"v"' && ns.other === null, JSON.stringify(ns));
  await close(wid);

  // ── D. Trusted modules / local-app fields ──────────────────────────────────
  const injected = await page.evaluate(async (s) => {
    const list = JSON.parse(localStorage.getItem('ltf:user-apps') || '[]');
    list.push({ id: 'web-evil-mod', name: 'Evil Mod', type: 'native', runtime: 'direct', target: s, local: true,
      module: '../../evil-marker-module', fallback: '../../evil-marker-fallback', panel: '../evil-marker-panel',
      sandbox: null, allow: 'camera; microphone', proxy: 'javascript:alert(1)', controls: ['panel'], icon: 'constructor' });
    localStorage.setItem('ltf:user-apps', JSON.stringify(list));
    await window.ltf.registry.load();
    const a = window.ltf.registry.get('web-evil-mod');
    return { module: a.module, type: a.type, fallback: a.fallback ?? null, panel: a.panel ?? null, sandbox: 'sandbox' in a, allow: a.allow ?? null, proxy: a.proxy ?? null, controls: a.controls ?? null, icon: a.icon };
  }, SITE);
  check('D1 malicious local-app manifest: module forced to webapp, dangerous fields dropped', injected.module === 'webapp' && injected.type === 'web-app' && injected.fallback === null && injected.panel === null && !injected.sandbox && injected.allow === null && injected.proxy === null && injected.controls === null && injected.icon !== 'constructor', JSON.stringify(injected));
  const evilWin = await page.evaluate(async () => (await window.ltf.wm.open('web-evil-mod')).id);
  await page.waitForTimeout(900);
  const evilFrame = await page.evaluate((w) => { const i = document.querySelector(`.window[data-id="${w}"] .app.webapp iframe`); return i && { src: i.getAttribute('src'), sandbox: i.getAttribute('sandbox') }; }, evilWin);
  check('D2 …and it still launches as a normal sandboxed web app', evilFrame?.src === SITE && /allow-scripts/.test(evilFrame?.sandbox || ''), JSON.stringify(evilFrame));
  await close(evilWin);

  const loadAttempts = await page.evaluate(async () => {
    const R = window.ltf.registry; const app = R.get('notepad'); const orig = app.module; const out = {};
    for (const v of ['../../evil-marker-load', 'https://evil.example/evil-marker-abs', 'javascript:alert(1)', 'data:text/javascript,window.__pwned=1', 'constructor', '__proto__', '..%2F..%2Fevil-marker-enc', 'unknown']) {
      app.module = v;
      out[v] = await R.loadModule('notepad').then(() => 'imported', (e) => (/untrusted/.test(e.message) ? 'refused' : 'error: ' + e.message));
    }
    app.module = orig;
    out.__legit = await R.loadModule('notepad').then((m) => (typeof m.mount === 'function' ? 'imported' : 'bad'), (e) => e.message);
    out.__pwned = !!window.__pwned;
    return out;
  });
  check('D3 loadModule refuses traversal / absolute / javascript: / data: / prototype / encoded / unknown', Object.entries(loadAttempts).filter(([k]) => !k.startsWith('__')).every(([, v]) => v === 'refused') && !loadAttempts.__pwned, JSON.stringify(loadAttempts));
  check('D4 legitimate built-in module still imports', loadAttempts.__legit === 'imported');

  const panelWin = await page.evaluate(async () => { window.ltf.registry.get('geforcenow').panel = '../evil-marker-panel2'; return (await window.ltf.wm.open('geforcenow')).id; });
  await page.waitForTimeout(600);
  const panelText = await page.evaluate(async (w) => {
    const btn = [...document.querySelectorAll(`.window[data-id="${w}"] .win-app-controls button`)].find((b) => b.title === 'Details');
    btn.click(); await new Promise((r) => setTimeout(r, 400));
    return document.querySelector(`.window[data-id="${w}"] .webapp-panel`)?.textContent || '';
  }, panelWin);
  check('D5 webapp panel import refuses an untrusted name', /untrusted panel module refused/.test(panelText), panelText);
  await page.evaluate(() => { window.ltf.registry.get('geforcenow').panel = 'geforcenow'; });
  await close(panelWin);
  const markers = requested.filter((u) => /evil-marker/.test(u));
  check('D6 no request was ever made for an injected module path', markers.length === 0, markers.join(' '));

  // ── E. Legitimate desktop unaffected ───────────────────────────────────────
  const desk = await page.evaluate(async () => {
    const n = await window.ltf.wm.open('notepad');
    const ok = !!document.querySelector(`.window[data-id="${n.id}"]`);
    window.ltf.wm.close(n.id);
    return { notepad: ok, widgets: [...document.querySelectorAll('#widgets > .widget')].map((w) => w.dataset.widget) };
  });
  check('E1 native app and widgets still work', desk.notepad && desk.widgets.join() === 'clock,sysmon,netmon', JSON.stringify(desk));

  const expected = /untrusted .* module refused|net::ERR|ERR_ABORTED|Failed to load resource|WebSocket connection to .* failed/;
  const real = consoleErrors.filter((e) => !expected.test(e));
  check('E2 no unexpected console errors', real.length === 0, real.join(' | '));
} catch (err) {
  fail++;
  console.log('FAIL — harness error ::', err.stack || err);
} finally {
  await cleanup();
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
