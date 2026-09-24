// Runtime seam — observable browser regression tests.
//
//   cargo build && node tests/browser/runtime.browser.mjs
//
// Self-contained: starts a throwaway LTF OS server (free port, temporary data
// dir) and a local HTML test site, then drives the real OS in Chromium via
// Playwright. The throwaway server is started with LTF_PROXY_ALLOW_PRIVATE=1 so
// its preflight and /proxy/page can reach the local test site; that setting is
// scoped to this test process only.
//
// Requirements: the debug binary (or LTF_BIN), and Playwright with a Chromium
// build (resolved from a local install or `npm root -g`; override the browser
// with CHROMIUM_PATH). Contract-level checks that need no browser live in
// tests/runtime-contract.test.mjs.

import { spawn, execSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ── harness ────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) pass++; else fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}${!cond && detail ? ' :: ' + detail : ''}`);
}

async function loadPlaywright() {
  try { const m = await import('playwright'); return m.default ?? m; } catch { /* not installed locally */ }
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
  while (Date.now() < until) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${url}`);
}

// Local HTML test site: embeddable, cross-origin to the OS.
const SITE_HTML = '<!doctype html><html><head><title>Runtime Test Site</title></head><body><h1>runtime test</h1></body></html>';
const site = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(SITE_HTML); });
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${site.address().port}/`;

// Throwaway LTF OS server.
const bin = process.env.LTF_BIN || path.join(REPO, 'target/debug/ltf-os');
if (!fs.existsSync(bin)) { console.error(`LTF OS binary not found at ${bin} — run \`cargo build\` or set LTF_BIN.`); process.exit(2); }
const port = await freePort();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltf-runtime-test-'));
const server = spawn(bin, [], {
  cwd: REPO,
  env: {
    ...process.env, PORT: String(port), LTF_DATA_DIR: dataDir,
    LTF_STATIC_DIR: path.join(REPO, 'static'), LTF_CONTENT_DIR: path.join(REPO, 'content'),
    LTF_PROXY_ALLOW_PRIVATE: '1', LTF_RATE_LIMIT: '100000',
  },
  stdio: 'ignore',
});
const BASE = `http://127.0.0.1:${port}`;

let browser;
async function cleanup() {
  await browser?.close().catch(() => {});
  if (server.exitCode === null) {
    const exited = new Promise((r) => server.once('exit', r));
    server.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  }
  site.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

try {
  await waitFor(`${BASE}/api/ping`);
  const pre = await (await fetch(`${BASE}/api/web/inspect?url=${encodeURIComponent(SITE)}`)).json();
  if (!pre.embeddable || !pre.isolated_available) throw new Error(`test site preflight unexpected: ${JSON.stringify(pre)}`);

  const { chromium } = await loadPlaywright();
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await (await browser.newContext()).newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.ltf?.registry && window.ltf?.wm, null, { timeout: 15000 });
  await page.waitForTimeout(300);

  // ── helpers (all observable: DOM, WM state, network targets) ──
  const mk = (name, runtime, extra) => page.evaluate(([n, r, s, x]) =>
    window.ltf.registry.createLocal({ name: n, target: s, runtime: r, permissions: [] }, x ? { extra: x } : {}).id, [name, runtime, SITE, extra]);
  const rm = (id) => page.evaluate((i) => window.ltf.registry.removeLocal(i), id);
  const closeWin = async (wid) => { await page.evaluate((i) => window.ltf.wm.close(i), wid); await page.waitForTimeout(260); };
  async function launch(appId, args = {}) {
    const winId = await page.evaluate(async ([id, a]) => (await window.ltf.wm.open(id, a))?.id, [appId, args]);
    await page.waitForTimeout(600);
    return page.evaluate((wid) => {
      const w = window.ltf.wm.windows.get(wid);
      const el = document.querySelector(`.window[data-id="${wid}"]`);
      const ifr = el?.querySelector('.app.webapp iframe');
      return {
        winId: wid,
        src: ifr ? ifr.getAttribute('src') : null,
        sandbox: ifr ? ifr.getAttribute('sandbox') : null,
        handoff: el?.querySelector('.frame-placeholder h2')?.textContent ?? null,
        controls: [...(el?.querySelectorAll('.win-app-controls button') || [])].map((b) => b.title),
        hooks: w?.instance ? Object.keys(w.instance).sort() : [],
      };
    }, winId);
  }
  const FRAME_HOOKS = ['destroy', 'onArgs', 'onFocus', 'onMinimize', 'onRestore'];
  const isIsolated = (r) => (r.src || '').startsWith('/proxy/page?url=') && r.sandbox && !r.sandbox.includes('allow-same-origin');
  const isDirect = (r) => r.src === SITE && (r.sandbox || '').includes('allow-same-origin');

  // ── existing runtime behavior ──
  const dId = await mk('RT Direct', 'direct');
  const eId = await mk('RT Embed', 'embed');
  const xId = await mk('RT External', 'external');

  const direct = await launch(dId);
  check('direct: loads the target in a direct iframe', isDirect(direct), JSON.stringify(direct));
  check('direct: lifecycle object is the frame instance wm.js drives', JSON.stringify(direct.hooks) === JSON.stringify(FRAME_HOOKS), JSON.stringify(direct.hooks));
  const embed = await launch(eId);
  check('embed: same frame, sandbox, controls and lifecycle as direct',
    isDirect(embed) && embed.sandbox === direct.sandbox && JSON.stringify(embed.controls) === JSON.stringify(direct.controls) && JSON.stringify(embed.hooks) === JSON.stringify(direct.hooks), JSON.stringify(embed));
  const ext = await launch(xId);
  check('external: Orion hand-off screen, no iframe', ext.src === null && /opens in Orion/.test(ext.handoff || ''), JSON.stringify(ext));
  check('external: lifecycle object is { onArgs }', JSON.stringify(ext.hooks) === '["onArgs"]', JSON.stringify(ext.hooks));
  const handoff = await page.evaluate(async ([wid, site]) => {
    document.querySelector(`.window[data-id="${wid}"] .frame-actions .btn.primary`).click();
    await new Promise((r) => setTimeout(r, 600));
    const orion = [...window.ltf.wm.windows.values()].filter((w) => w.appId === 'orion');
    return { orion: orion.length, appClosed: !window.ltf.wm.windows.has(wid), site };
  }, [ext.winId, SITE]);
  check('external: "Open in Orion" opens Orion and closes the app window', handoff.orion === 1 && handoff.appClosed, JSON.stringify(handoff));
  await page.evaluate(() => [...window.ltf.wm.windows.values()].filter((w) => w.appId === 'orion').forEach((w) => window.ltf.wm.close(w.id)));
  await closeWin(direct.winId); await closeWin(embed.winId);

  // ── proxy:"isolated" stays orthogonal ──
  const isoD = await mk('RT Iso Direct', 'direct', { proxy: 'isolated' });
  const isoE = await mk('RT Iso Embed', 'embed', { proxy: 'isolated' });
  const a = await launch(isoD);
  check('proxy: runtime direct + proxy isolated → /proxy/page, opaque-origin sandbox', isIsolated(a), JSON.stringify(a));
  const b = await launch(isoE);
  check('proxy: runtime embed + proxy isolated → /proxy/page, opaque-origin sandbox', isIsolated(b), JSON.stringify(b));
  check('proxy: isolation does not change the lifecycle object', JSON.stringify(a.hooks) === JSON.stringify(FRAME_HOOKS) && JSON.stringify(b.hooks) === JSON.stringify(FRAME_HOOKS));
  const isoArg = await launch(dId, { proxy: 'isolated' });
  check('proxy: launch-arg proxy isolated → /proxy/page', isIsolated(isoArg), JSON.stringify(isoArg));
  const extIso = await launch(xId, { proxy: 'isolated' });
  check('proxy: external + proxy isolated is still a hand-off (proxy is not a runtime)', extIso.src === null && /opens in Orion/.test(extIso.handoff || ''), JSON.stringify(extIso));
  const proxied = await page.evaluate((u) => fetch(`/proxy/page?url=${encodeURIComponent(u)}`).then((r) => r.headers.get('content-security-policy')), SITE);
  check('proxy: /proxy/page sandbox CSP unchanged (no allow-same-origin)', /^sandbox /.test(proxied || '') && !proxied.includes('allow-same-origin'), proxied);
  await closeWin(isoArg.winId); await closeWin(extIso.winId);

  // ── LTF API boundary unchanged ──
  async function bridgeReplies(winId) {
    const fr = await (await page.$(`.window[data-id="${winId}"] iframe`)).contentFrame();
    return fr.evaluate(() => new Promise((resolve) => {
      let got = false;
      addEventListener('message', (e) => { if (e.data?.source === 'ltf-host') got = true; });
      for (const m of [{ type: 'hello' }, { type: 'storage', op: 'get', key: 'k', rid: 's' }, { type: 'window', op: 'getState', rid: 'w' }, { type: 'notify', title: 'x' }]) {
        parent.postMessage({ source: 'ltf-app', permissions: ['storage', 'window', 'notifications'], ...m }, '*');
      }
      setTimeout(() => resolve(got), 600);
    }));
  }
  const d2 = await launch(dId);
  check('api: direct frame receives no LTF API reply', (await bridgeReplies(d2.winId)) === false);
  await closeWin(d2.winId);
  const e2 = await launch(eId);
  check('api: embed frame receives no LTF API reply', (await bridgeReplies(e2.winId)) === false);
  await closeWin(e2.winId);
  check('api: isolated /proxy/page frame receives no LTF API reply', (await bridgeReplies(a.winId)) === false);
  check('api: isolated embed frame receives no LTF API reply', (await bridgeReplies(b.winId)) === false);
  await closeWin(a.winId); await closeWin(b.winId);

  const pg = await launch('playground');
  const pgFrame = await (await page.$(`.window[data-id="${pg.winId}"] iframe`)).contentFrame();
  await pgFrame.waitForFunction(() => window.ltf?.app?.id, null, { timeout: 8000 });
  const api = await pgFrame.evaluate(async () => {
    await window.ltf.storage.set('rt', 7);
    const v = await window.ltf.storage.get('rt');
    await window.ltf.storage.clear();
    return { perms: window.ltf.app.permissions, v, state: await window.ltf.window.getState() };
  });
  check('api: first-party direct app (playground) keeps its API + permissions',
    api.v === 7 && api.state.focused === true && JSON.stringify(api.perms) === '["notifications","open-external","storage","window"]', JSON.stringify(api));
  await page.evaluate(() => { window.ltf.registry.get('playground').permissions = ['notifications', 'open-external', 'window']; });
  const denied = await pgFrame.evaluate(() => window.ltf.storage.get('x').then(() => 'resolved', (e) => e.message));
  check('api: permissions still enforced host-side (storage revoked → rejected)', /permission denied/.test(denied), denied);
  await page.evaluate(() => { window.ltf.registry.get('playground').permissions = ['notifications', 'open-external', 'storage', 'window']; });
  await closeWin(pg.winId);

  // ── local apps, stored manifests, launch args ──
  const created = await page.evaluate((s) => {
    const R = window.ltf.registry;
    const out = {};
    for (const rt of ['direct', 'embed', 'external']) {
      const app = R.createLocal({ name: 'Local ' + rt, target: s, runtime: rt, permissions: [] });
      const stored = JSON.parse(localStorage.getItem('ltf:user-apps')).find((x) => x.id === app.id);
      out[rt] = { live: app.runtime, stored: stored.runtime };
      R.removeLocal(app.id);
    }
    return out;
  }, SITE);
  check('local: every supported runtime is kept (live + stored)', Object.entries(created).every(([k, v]) => v.live === k && v.stored === k), JSON.stringify(created));

  const malformed = await page.evaluate(async (s) => {
    const list = JSON.parse(localStorage.getItem('ltf:user-apps') || '[]');
    const bad = { constructor: 'constructor', proto: '__proto__', obj: { id: 'external' }, arr: ['external'], upper: 'EXTERNAL', num: 7 };
    for (const [k, rt] of Object.entries(bad)) list.push({ id: `web-bad-${k}`, name: `Bad ${k}`, type: 'web-app', runtime: rt, target: s, local: true });
    localStorage.setItem('ltf:user-apps', JSON.stringify(list));
    await window.ltf.registry.load();
    return Object.keys(bad).map((k) => [k, window.ltf.registry.get(`web-bad-${k}`)?.runtime]);
  }, SITE);
  check('local: malformed stored runtimes load sanitized to "direct"', malformed.every(([, rt]) => rt === 'direct'), JSON.stringify(malformed));
  const badLaunch = await launch('web-bad-obj');
  check('local: a sanitized malformed app mounts through the direct frame', isDirect(badLaunch), JSON.stringify(badLaunch));
  await closeWin(badLaunch.winId);
  for (const [k] of malformed) await rm(`web-bad-${k}`);

  for (const bad of ['constructor', '__proto__', 'toString', 'EXTERNAL', 'not-a-runtime']) {
    const r = await launch(xId, { runtime: bad });
    check(`launch arg runtime ${JSON.stringify(bad)} → default direct frame`, isDirect(r), JSON.stringify(r));
    await closeWin(r.winId);
  }
  const argExt = await launch(dId, { runtime: 'external' });
  check('launch arg runtime "external" is honoured', argExt.src === null && /opens in Orion/.test(argExt.handoff || ''), JSON.stringify(argExt));
  await closeWin(argExt.winId);
  const argEmbed = await launch(xId, { runtime: 'embed' });
  check('launch arg runtime "embed" is honoured', isDirect(argEmbed), JSON.stringify(argEmbed));
  await closeWin(argEmbed.winId);

  // ── fail closed: a defined runtime with no handler (real mount, injected table) ──
  const failClosed = await page.evaluate(async (s) => {
    const m = await import('/js/apps/webapp.js');
    const root = document.createElement('div');
    const ctx = { app: { id: 'fc', name: 'FC', runtime: 'external', target: s }, args: {}, win: { setTitle() {}, setControls() {}, close() {} }, open() {} };
    const inst = m.mountWithHandlers(root, ctx, { direct: m.RUNTIME_HANDLERS.direct });
    return { code: root.querySelector('[data-code]')?.dataset.code, iframes: root.querySelectorAll('iframe').length, inst: inst ?? null, missing: m.missingRuntimeHandlers() };
  }, SITE);
  check('fail-closed: defined runtime without handler renders RUNTIME_UNAVAILABLE, loads nothing',
    failClosed.code === 'RUNTIME_UNAVAILABLE' && failClosed.iframes === 0 && failClosed.inst === null, JSON.stringify(failClosed));
  check('fail-closed: shipped handler table has no gaps', JSON.stringify(failClosed.missing) === '[]');
  const expectedFailClosed = consoleErrors.findIndex((e) => e.includes('has no handler; refusing to mount'));
  if (expectedFailClosed >= 0) consoleErrors.splice(expectedFailClosed, 1); // produced on purpose above

  // ── window lifecycle through a runtime-mounted instance ──
  const sus = await mk('RT Suspend', 'direct', { suspendOnMinimize: true });
  const life = await launch(sus);
  const other = await launch(eId);
  const lc = await page.evaluate(async ([wid, oid]) => {
    const wm = window.ltf.wm;
    const el = document.querySelector(`.window[data-id="${wid}"]`);
    const r = {};
    wm.focus(oid); r.blurred = !wm.stateOf(wid).focused;
    wm.focus(wid); await new Promise((x) => setTimeout(x, 50));
    r.focused = wm.stateOf(wid).focused && document.activeElement === el.querySelector('iframe'); // instance.onFocus
    wm.minimize(wid); r.minimized = wm.stateOf(wid).minimized && !el.querySelector('iframe'); // instance.onMinimize → suspend
    wm.restore(wid); await new Promise((x) => setTimeout(x, 400));
    r.restoredFrame = !wm.stateOf(wid).minimized && !!el.querySelector('iframe'); // instance.onRestore → resume
    wm.toggleMaximize(wid); r.maximized = wm.stateOf(wid).maximized && el.classList.contains('maximized');
    wm.toggleMaximize(wid); r.unmaximized = !wm.stateOf(wid).maximized;
    return r;
  }, [life.winId, other.winId]);
  check('lifecycle: focus/unfocus reaches the instance (onFocus focuses the frame)', lc.blurred && lc.focused, JSON.stringify(lc));
  check('lifecycle: minimize → onMinimize (frame suspended)', lc.minimized, JSON.stringify(lc));
  check('lifecycle: restore → onRestore (frame resumed)', lc.restoredFrame, JSON.stringify(lc));
  check('lifecycle: maximize / unmaximize', lc.maximized && lc.unmaximized, JSON.stringify(lc));

  // resize via the real title-bar resize handle
  const winEl = await page.$(`.window[data-id="${life.winId}"]`);
  const before = await winEl.boundingBox();
  const handle = await page.$(`.window[data-id="${life.winId}"] .win-resize[data-dir="se"]`);
  const hb = await handle.boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x - 80, hb.y - 60, { steps: 5 });
  await page.mouse.up();
  const after = await winEl.boundingBox();
  const stillFramed = await page.evaluate((wid) => !!document.querySelector(`.window[data-id="${wid}"] .app.webapp iframe`), life.winId);
  check('lifecycle: resize works and the runtime frame survives it', after.width < before.width && after.height < before.height && stillFramed, JSON.stringify({ before, after }));

  const closed = await page.evaluate(async (wid) => {
    const ifr = document.querySelector(`.window[data-id="${wid}"] iframe`);
    window.ltf.wm.close(wid);
    return { gone: !window.ltf.wm.windows.has(wid), released: ifr.getAttribute('src') === 'about:blank' };
  }, life.winId);
  check('lifecycle: close → destroy() releases the frame', closed.gone && closed.released, JSON.stringify(closed));
  await closeWin(other.winId);

  // ── App Store runtime choices ──
  await page.evaluate(() => window.ltf.wm.open('appstore'));
  await page.waitForSelector('.window[data-app="appstore"] .store-card', { timeout: 8000 });
  const opts = await page.evaluate(async () => {
    const w = document.querySelector('.window[data-app="appstore"]');
    w.querySelector('.app-toolbar .btn.primary').click();
    await new Promise((r) => setTimeout(r, 150));
    const o = [...w.querySelectorAll('form.store-dialog select option')].map((x) => [x.value, x.textContent]);
    w.querySelector('.store-dialog-backdrop')?.remove();
    return o;
  });
  const { RUNTIME_DEFS } = await import(pathToFileURL(path.join(REPO, 'static/js/core/runtimes.js')).href);
  check('app store: runtime options are exactly the authoritative definitions',
    JSON.stringify(opts) === JSON.stringify(RUNTIME_DEFS.map((d) => [d.id, d.label])), JSON.stringify(opts));

  for (const id of [dId, eId, xId, isoD, isoE, sus]) await rm(id);

  const real = consoleErrors.filter((e) => !/net::ERR|ERR_TUNNEL|ERR_PROXY|ERR_ABORTED/.test(e));
  check('no unexpected console errors', real.length === 0, real.join(' | '));
} catch (err) {
  fail++;
  console.log('FAIL — harness error ::', err.stack || err);
} finally {
  await cleanup();
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
