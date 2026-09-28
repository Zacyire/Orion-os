// Production deployment — end-to-end through a real HTTPS reverse proxy.
//
//   cargo build && node tests/browser/deploy.browser.mjs
//
// Production-shaped and self-contained: a throwaway Orion OS server in production
// mode — configured from deploy/orion-os.env.example itself (LTF_MODE=production,
// loopback bind, LTF_PROXY=0, …), with only paths, ports, the hostname and a
// throwaway access key file substituted —
// behind nginx running deploy/nginx-orion-os.conf — the documented config,
// with only placeholders (domain, ports, certificate paths) substituted. A
// self-signed certificate is generated for the test hostname, and Chromium
// resolves that hostname to 127.0.0.1, so the browser really speaks HTTPS +
// HTTP/2 to the proxy, which forwards HTTP/1.1 + WebSocket upgrades to Orion OS.
//
// ORION_PROXY=caddy runs the same checks against deploy/Caddyfile.example
// instead. Needs openssl plus nginx or caddy on PATH (override with
// NGINX_BIN / CADDY_BIN). Playwright is
// resolved locally or from `npm root -g` (CHROMIUM_PATH overrides the browser).
// Nothing leaves the machine: the connectivity check points at a local mock.

import { spawn, execSync, execFileSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function which(cmd) { try { return execSync(`command -v ${cmd}`).toString().trim(); } catch { return null; } }

const bin = process.env.LTF_BIN || path.join(REPO, 'target/debug/ltf-os');
if (!fs.existsSync(bin)) { console.error(`binary not found at ${bin} — run \`cargo build\` or set LTF_BIN`); process.exit(2); }
const PROXY = process.env.ORION_PROXY || 'nginx';
const proxyBin = PROXY === 'caddy'
  ? process.env.CADDY_BIN || which('caddy')
  : process.env.NGINX_BIN || which('nginx') || (fs.existsSync('/usr/sbin/nginx') ? '/usr/sbin/nginx' : null);
if (!['nginx', 'caddy'].includes(PROXY) || !proxyBin || !which('openssl')) { console.error(`${PROXY} and openssl are required for the deployment test (set NGINX_BIN / CADDY_BIN)`); process.exit(2); }
console.log(`reverse proxy: ${PROXY} (${proxyBin})`);

const HOSTNAME = 'beta.orion.test';
const KEY = 'test-access-key-' + Math.random().toString(36).slice(2) + '-x9';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-deploy-test-'));
const dataDir = path.join(work, 'data');
const appPort = await freePort();
const tlsPort = await freePort();
const httpPort = await freePort();
const ORIGIN = `https://${HOSTNAME}:${tlsPort}`;

// Local mock connectivity target for /api/network/stats.
const target = http.createServer((q, r) => { r.writeHead(204); r.end(); });
await new Promise((r) => target.listen(0, '127.0.0.1', r));

// Self-signed certificate for the test hostname.
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${HOSTNAME}`,
  '-addext', `subjectAltName=DNS:${HOSTNAME}`, '-keyout', path.join(work, 'key.pem'), '-out', path.join(work, 'cert.pem')], { stdio: 'ignore' });

// The documented proxy config, placeholders substituted — nothing else
// (Caddy additionally gets test ports and the self-signed certificate).
let proxyArgs;
if (PROXY === 'nginx') {
  const site = fs.readFileSync(path.join(REPO, 'deploy/nginx-orion-os.conf'), 'utf8')
    .replaceAll('orion.YOUR_DOMAIN', HOSTNAME)
    .replaceAll(`/etc/letsencrypt/live/${HOSTNAME}/fullchain.pem`, path.join(work, 'cert.pem'))
    .replaceAll(`/etc/letsencrypt/live/${HOSTNAME}/privkey.pem`, path.join(work, 'key.pem'))
    .replaceAll('listen 443 ssl', `listen 127.0.0.1:${tlsPort} ssl`)
    .replaceAll('listen 80;', `listen 127.0.0.1:${httpPort};`)
    .replaceAll('http://127.0.0.1:8080', `http://127.0.0.1:${appPort}`);
  fs.writeFileSync(path.join(work, 'site.conf'), site);
  fs.writeFileSync(path.join(work, 'nginx.conf'), `
daemon off;
master_process on;
worker_processes 1;
pid ${work}/nginx.pid;
error_log ${work}/nginx-error.log warn;
${process.getuid?.() === 0 ? 'user root;' : ''}
events { worker_connections 256; }
http {
  access_log ${work}/proxy-access.log;
  client_body_temp_path ${work}/cb; proxy_temp_path ${work}/px; fastcgi_temp_path ${work}/fc; uwsgi_temp_path ${work}/uw; scgi_temp_path ${work}/sc;
  include ${work}/site.conf;
}`);
  proxyArgs = ['-p', work, '-c', path.join(work, 'nginx.conf')];
} else {
  const site = fs.readFileSync(path.join(REPO, 'deploy/Caddyfile.example'), 'utf8')
    .replace('orion.YOUR_DOMAIN {', `orion.YOUR_DOMAIN {\n\ttls ${path.join(work, 'cert.pem')} ${path.join(work, 'key.pem')}\n\tlog {\n\t\toutput file ${work}/proxy-access.log\n\t}`)
    .replaceAll('orion.YOUR_DOMAIN', HOSTNAME)
    .replaceAll('127.0.0.1:8080', `127.0.0.1:${appPort}`);
  fs.writeFileSync(path.join(work, 'Caddyfile'), `{\n\tadmin off\n\thttp_port ${httpPort}\n\thttps_port ${tlsPort}\n\tdefault_bind 127.0.0.1\n\tstorage file_system ${work}/caddy\n}\n\n${site}`);
  proxyArgs = ['run', '--config', path.join(work, 'Caddyfile'), '--adapter', 'caddyfile'];
}

let serverLog = '';
// The documented production env file, as systemd would load it.
const documentedEnv = Object.fromEntries(fs.readFileSync(path.join(REPO, 'deploy/orion-os.env.example'), 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
fs.writeFileSync(path.join(work, 'access-key'), KEY + '\n', { mode: 0o600 });
const serverEnv = {
  ...documentedEnv,
  // substitutions only: placeholders, paths, ports, the key file, a local probe target, verbose logs
  PORT: String(appPort), LTF_ALLOWED_HOSTS: HOSTNAME, LTF_ACCESS_KEY_FILE: path.join(work, 'access-key'),
  LTF_DATA_DIR: dataDir, LTF_STATIC_DIR: path.join(REPO, 'static'), LTF_CONTENT_DIR: path.join(REPO, 'content'),
  LTF_NETCHECK_URL: `http://127.0.0.1:${target.address().port}/`,
  RUST_LOG: 'ltf_os=debug,tower_http=debug',
};
const { LTF_ACCESS_KEY: _unused, ...inherited } = process.env;
const server = spawn(bin, [], {
  cwd: REPO,
  env: { ...inherited, ...serverEnv },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
const proxy = spawn(proxyBin, proxyArgs, { stdio: 'ignore', env: { ...process.env, HOME: work, XDG_DATA_HOME: work, XDG_CONFIG_HOME: work } });

let browser;
async function cleanup() {
  await browser?.close().catch(() => {});
  for (const p of [proxy, server]) {
    if (p.exitCode === null) { const done = new Promise((r) => p.once('exit', r)); p.kill(); await Promise.race([done, sleep(3000)]); }
  }
  target.close();
  fs.rmSync(work, { recursive: true, force: true });
}

/** Raw HTTPS request through the proxy (SNI = test hostname), for header-level checks. */
function rawHttps({ method = 'GET', pathName = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: '127.0.0.1', port: tlsPort, servername: HOSTNAME, method, path: pathName, rejectUnauthorized: false,
      headers: { host: `${HOSTNAME}:${tlsPort}`, ...headers },
    }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); });
    req.on('upgrade', (res, sock) => { sock.destroy(); resolve({ status: res.statusCode, headers: res.headers, body: '' }); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
const wsUpgrade = (headers) => rawHttps({ pathName: '/ws', headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers } });

async function waitUp(ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if ((await rawHttps({ pathName: '/healthz' })).status === 200) return; } catch { /* not up */ }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${PROXY} → Orion OS`);
}

try {
  await waitUp();

  // ── Transport: HTTPS, redirect, unknown names, loopback-only backend ──
  const health = await rawHttps({ pathName: '/healthz' });
  check(`HTTPS via ${PROXY} reaches Orion OS (/healthz → ok, no session needed)`, health.status === 200 && health.body === 'ok', `${health.status} ${health.body}`);
  check('HSTS header is set by the proxy', /max-age=\d+/.test(health.headers['strict-transport-security'] || ''));
  check('no Server version banner', !/\d/.test(health.headers.server || ''), health.headers.server);
  const plain = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: httpPort, path: '/x', headers: { host: HOSTNAME } }, (r) => { r.resume(); resolve(r); }));
  check('plain HTTP redirects to HTTPS', [301, 308].includes(plain.statusCode) && plain.headers.location?.startsWith(`https://${HOSTNAME}`), `${plain.statusCode} ${plain.headers.location}`);
  const sniRejected = await new Promise((resolve) => {
    const s = tls.connect({ host: '127.0.0.1', port: tlsPort, servername: 'evil.example', rejectUnauthorized: false });
    s.once('secureConnect', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(true));
  });
  check('TLS handshake for an unknown server name is rejected', sniRejected);
  const lanReachable = await new Promise((resolve) => {
    const addrs = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal);
    if (!addrs.length) return resolve(false);
    const s = net.connect({ host: addrs[0].address, port: appPort });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
  check('production env example: LTF_MODE=production, loopback bind, web fetching off', documentedEnv.LTF_MODE === 'production' && documentedEnv.LTF_BIND === '127.0.0.1' && documentedEnv.LTF_PROXY === '0');
  check('Orion OS backend is bound to loopback only in production mode', !lanReachable);

  // ── Host policy through the proxy ──
  // The proxy refuses a Host it doesn't serve (nginx: catch-all 421; Caddy:
  // no matching site), so such requests never reach Orion OS; Orion's own
  // Host check (403) is the second layer, covered by the Rust route tests.
  for (const [label, host] of [['untrusted', 'evil.example'], ['look-alike', `${HOSTNAME}.evil.example`], ['subdomain', `x.${HOSTNAME}`], ['malformed', `user@${HOSTNAME}`]]) {
    const r = await rawHttps({ pathName: '/healthz', headers: { host } });
    check(`${label} Host is not served by Orion OS (proxy answered ${r.status})`, r.body !== 'ok', `${r.status} ${r.body.slice(0, 60)}`);
  }
  const beforeHosts = serverLog;
  check('refused Hosts never reached the Orion OS backend', !/evil\.example/.test(beforeHosts));

  // ── Access gate without a browser ──
  const anonApi = await rawHttps({ pathName: '/api/files' });
  check('unauthenticated API → 401 UNAUTHENTICATED', anonApi.status === 401 && anonApi.body.includes('UNAUTHENTICATED'), `${anonApi.status}`);
  const anonShell = await rawHttps({ pathName: '/', headers: { accept: 'text/html' } });
  check('unauthenticated navigation → sign-in page (401), not the desktop', anonShell.status === 401 && anonShell.body.includes('action="/login"') && !anonShell.body.includes('js/app.js'));
  const anonWs = await wsUpgrade({ origin: ORIGIN });
  check('unauthenticated same-origin WebSocket → 401', anonWs.status === 401, String(anonWs.status));
  const csrfLogin = await rawHttps({ method: 'POST', pathName: '/login', headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, body: `key=${encodeURIComponent(KEY)}` });
  check('cross-origin sign-in refused even with the right key', csrfLogin.status === 403 && !csrfLogin.headers['set-cookie'], String(csrfLogin.status));

  // ── Real browser, HTTPS, non-localhost hostname ──
  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    // direct://: never send the test hostname to an ambient system proxy.
    // --ignore-certificate-errors: the test certificate is self-signed; without it
    // Chromium refuses to register the service worker, which this test exercises.
    args: [`--host-resolver-rules=MAP ${HOSTNAME} 127.0.0.1`, '--proxy-server=direct://', '--ignore-certificate-errors'],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const consoleErrors = [];
  const requestedUrls = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  page.on('request', (r) => requestedUrls.push(r.url()));
  const shellSockets = [];
  page.on('websocket', (ws) => {
    const rec = { url: ws.url(), frames: [], closed: false };
    ws.on('framereceived', (f) => rec.frames.push(String(f.payload)));
    ws.on('close', () => { rec.closed = true; });
    shellSockets.push(rec);
  });

  await page.goto(`${ORIGIN}/`);
  check('browser sees the sign-in page first', await page.locator('form[action="/login"]').count() === 1);
  check('no desktop before sign-in', await page.evaluate(() => !window.ltf));

  await page.fill('#key', 'definitely-not-the-key');
  await Promise.all([page.waitForLoadState(), page.click('button[type=submit]')]);
  check('wrong key → error, still signed out', await page.locator('.err').count() === 1 && (await ctx.cookies()).length === 0, (await page.content()).slice(0, 300));

  await page.fill('#key', KEY);
  await Promise.all([page.waitForURL(`${ORIGIN}/`), page.click('button[type=submit]')]);
  await page.waitForFunction(() => window.ltf?.wm, null, { timeout: 20000 });
  await page.waitForFunction(() => !document.body.classList.contains('booting'), null, { timeout: 30000 });
  check('right key → Orion OS desktop boots over HTTPS', true);
  const cookies = await ctx.cookies();
  const sess = cookies.find((c) => c.name === '__Host-orion_session');
  check('session cookie is __Host-, Secure, HttpOnly, SameSite=Lax, host-only', !!sess && sess.secure && sess.httpOnly && sess.sameSite === 'Lax' && sess.path === '/' && !sess.domain.startsWith('.'), JSON.stringify(sess));
  check('default sign-in lasts only for this browser session (shared/school computers)', sess?.expires === -1, String(sess?.expires));
  check('session cookie is invisible to page script', await page.evaluate(() => !document.cookie.includes('orion_session')));
  check('page is a secure context', await page.evaluate(() => window.isSecureContext));
  const proto = await page.evaluate(() => performance.getEntriesByType('navigation')[0]?.nextHopProtocol);
  check('browser ↔ proxy speaks HTTP/2 (backend still Host-checked)', proto === 'h2', proto);
  check('title is Orion OS', (await page.title()) === 'Orion OS', await page.title());

  // ── WebSocket through the proxy ──
  await page.waitForFunction(() => true);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !shellSockets.some((s) => s.frames.some((f) => f.includes('"hello"')))) await sleep(100);
  const shellWs = shellSockets.find((s) => s.url.endsWith('/ws'));
  check('desktop opened wss://<beta host>/ws', !!shellWs && shellWs.url === `wss://${HOSTNAME}:${tlsPort}/ws`, shellWs?.url);
  check('shell WebSocket received the hello greeting', !!shellWs?.frames.some((f) => f.includes('"hello"')));
  const pingPong = await page.evaluate(() => new Promise((resolve) => {
    const ws = new WebSocket(`wss://${location.host}/ws`);
    const got = [];
    ws.onmessage = (e) => { got.push(e.data); if (e.data.includes('"hello"')) ws.send('{"type":"ping"}'); if (e.data.includes('"pong"')) { ws.close(); resolve(got); } };
    ws.onerror = () => resolve(['error']);
    setTimeout(() => resolve(got), 6000);
  }));
  check(`ping → pong over wss through ${PROXY}`, pingPong.some((f) => f.includes('"pong"')), JSON.stringify(pingPong));
  const cookieHeader = `${sess.name}=${sess.value}`;
  for (const [label, origin, expect] of [
    ['foreign Origin', 'https://evil.example', 403],
    ['null Origin', 'null', 403],
    ['missing Origin', undefined, 403],
    ['look-alike Origin', `https://${HOSTNAME}.evil.example:${tlsPort}`, 403],
    ['http:// (downgraded) Origin', `http://${HOSTNAME}:${tlsPort}`, 403],
    ['same Origin (control)', ORIGIN, 101],
  ]) {
    const r = await wsUpgrade({ cookie: cookieHeader, ...(origin ? { origin } : {}) });
    check(`signed-in WebSocket with ${label} → ${expect}`, r.status === expect, String(r.status));
  }

  // ── Desktop behaviour ──
  const winState = await page.evaluate(async () => {
    const wm = window.ltf.wm;
    await wm.open('notepad');
    const w = wm.byApp('notepad')[0];
    const el = document.querySelector('.window[data-app="notepad"]');
    return { id: w?.id, ok: !!el, rect: el?.getBoundingClientRect().toJSON() };
  });
  check('a window opens', winState.ok, JSON.stringify(winState));
  const bar = page.locator('.window[data-app="notepad"] .win-titlebar');
  const bb = await bar.boundingBox();
  await page.mouse.move(bb.x + bb.width / 2, bb.y + 10);
  await page.mouse.down();
  await page.mouse.move(bb.x + bb.width / 2 - 80, Math.max(80, bb.y - 40), { steps: 8 }); // stay clear of the top-edge snap zone
  await page.mouse.up();
  const moved = await page.evaluate(() => document.querySelector('.window[data-app="notepad"]').getBoundingClientRect().toJSON());
  check('window moves by dragging its title bar', Math.abs(moved.x - winState.rect.x) > 20 || Math.abs(moved.y - winState.rect.y) > 20, `${JSON.stringify(winState.rect)} → ${JSON.stringify(moved)}`);
  const before = await page.evaluate(() => { const el = document.querySelector('.window[data-app="notepad"]'); return { w: el.offsetWidth, h: el.offsetHeight }; });
  const se = await page.locator('.window[data-app="notepad"] .win-resize[data-dir="se"]').boundingBox();
  await page.mouse.move(se.x + se.width / 2, se.y + se.height / 2);
  await page.mouse.down();
  await page.mouse.move(se.x + se.width / 2 - 120, se.y + se.height / 2 - 90, { steps: 8 });
  await page.mouse.up();
  const size = () => page.evaluate(() => { const el = document.querySelector('.window[data-app="notepad"]'); return { w: el.offsetWidth, h: el.offsetHeight }; });
  const resized = await size();
  check('window resizes from its corner', resized.w < before.w - 60 && resized.h < before.h - 40, `${before.w}x${before.h} → ${resized.w}x${resized.h}`);
  const states = await page.evaluate(async (id) => {
    const wm = window.ltf.wm;
    const out = [];
    wm.minimize(id); await new Promise((r) => setTimeout(r, 300)); out.push(wm.stateOf(id).minimized);
    wm.restore(id); await new Promise((r) => setTimeout(r, 300)); out.push(!wm.stateOf(id).minimized);
    wm.toggleMaximize(id); await new Promise((r) => setTimeout(r, 300)); out.push(wm.stateOf(id).maximized);
    wm.toggleMaximize(id); await new Promise((r) => setTimeout(r, 300)); out.push(!wm.stateOf(id).maximized);
    return out;
  }, winState.id);
  check('minimize / restore / maximize / unmaximize work', states.every(Boolean), JSON.stringify(states));

  // ── Widgets ──
  await page.waitForFunction(() => document.querySelector('.sysmon-status')?.textContent === 'Live', null, { timeout: 10000 }).catch(() => {});
  await page.waitForFunction(() => document.querySelector('.netmon-dot')?.dataset.kind === 'online', null, { timeout: 10000 }).catch(() => {});
  const widgets = await page.evaluate(() => ({
    ids: [...document.querySelectorAll('#widgets > .widget')].map((w) => w.dataset.widget),
    clock: document.querySelector('#widgets .widget[data-widget="clock"]')?.textContent.trim(),
    sysmon: document.querySelector('.sysmon-status')?.textContent,
    netmon: document.querySelector('.netmon-dot')?.dataset.kind,
  }));
  check('Clock widget renders a time', /\d{1,2}:\d{2}/.test(widgets.clock || ''), widgets.clock);
  check('System Monitor is Live through the proxy', widgets.sysmon === 'Live', widgets.sysmon);
  check('Network Monitor is Online through the proxy', widgets.netmon === 'online', widgets.netmon);

  // ── Apps: each opens a window (remote sites keep their own embedding rules) ──
  for (const id of ['youtube', 'geforcenow', 'orion', 'spiceify', 'appstore', 'settings']) {
    const ok = await page.evaluate(async (id) => {
      await window.ltf.wm.open(id);
      await new Promise((r) => setTimeout(r, 400));
      const el = document.querySelector(`.window[data-app="${id}"]`);
      return !!el && !el.textContent.includes('App crashed');
    }, id);
    check(`${id} opens`, ok);
  }

  // ── Sandboxed (opaque-origin) frames keep the session for their own navigations ──
  const frameOk = await page.evaluate(() => new Promise((resolve) => {
    const f = document.createElement('iframe');
    f.sandbox = 'allow-scripts';
    f.name = 'probe-frame';
    f.src = '/api/ping';
    f.onload = () => resolve(true);
    document.body.append(f);
    setTimeout(() => resolve(false), 5000);
  }));
  const probe = page.frames().find((f) => f.name() === 'probe-frame');
  const probeText = frameOk && probe ? await probe.evaluate(() => document.body.innerText).catch(() => '') : '';
  check('sandboxed iframe navigation (isolated-mode shape) is authenticated', probeText.includes('"pong"'), probeText.slice(0, 120));

  const shellSource = await page.evaluate(() => fetch('/js/core/api.js').then((r) => r.text()));
  check('frontend source contains no key', shellSource.includes('connectEvents') && !shellSource.includes(KEY));

  // ── Server-side web fetching is off in the production config ──
  const webLayer = await page.evaluate(async () => {
    const p = await fetch('/proxy/page?url=' + encodeURIComponent('https://example.com/'));
    const n = await fetch('/net/' + encodeURIComponent('https://example.com/'), { cache: 'no-store' });
    return { p: p.status, pb: await p.text(), n: n.status, nb: await n.text() };
  });
  check('/proxy/page and /net refuse to fetch other sites (LTF_PROXY=0)', webLayer.pb.includes('PROXY_DISABLED') && webLayer.nb.includes('PROXY_DISABLED'), JSON.stringify(webLayer).slice(0, 200));
  for (const [uri, label] of [['/api/system/stats', 'System stats'], ['/api/network/stats', 'Network stats']]) {
    const r = await page.evaluate(async (u) => { const x = await fetch(u); return { s: x.status, j: await x.json().catch(() => null) }; }, uri);
    check(`${label} API works through the proxy (${uri})`, r.s === 200 && r.j && typeof r.j.schema === 'number', JSON.stringify(r).slice(0, 160));
  }

  // ── Persistence: server files + browser storage survive a reload ──
  const saved = await page.evaluate(async () => {
    await window.ltf.api?.files?.write?.('beta-check.txt', 'hello from the beta');
    const r = await fetch('/api/files/beta-check.txt', { headers: { 'X-LTF-Client': '1' } });
    localStorage.setItem('ltf:beta-check', 'kept');
    return r.ok ? await r.text() : `status ${r.status}`;
  });
  const writeViaApi = saved.includes('hello') ? saved : await page.evaluate(async () => {
    const r = await fetch('/api/files/beta-check.txt', { method: 'PUT', headers: { 'X-LTF-Client': '1', 'Content-Type': 'text/plain' }, body: 'hello from the beta' });
    const g = await fetch('/api/files/beta-check.txt');
    return r.ok && g.ok ? await g.text() : `status ${r.status}/${g.status}`;
  });
  check('Notepad drive (server-side files) writes and reads through the proxy', writeViaApi.includes('hello from the beta'), writeViaApi);
  await page.reload();
  await page.waitForFunction(() => window.ltf?.wm, null, { timeout: 20000 });
  check('reload keeps the session (no second sign-in)', await page.locator('form[action="/login"]').count() === 0);
  check('browser storage (ltf: keys) survives reload unchanged', await page.evaluate(() => localStorage.getItem('ltf:beta-check') === 'kept'));

  // ── Sign-out ──
  const swActive = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return !!r.active; }).catch(() => false);
  check('service worker is active on the HTTPS origin', swActive);
  await page.evaluate(() => fetch('/logout', { method: 'POST' }));
  const afterLogout = await page.evaluate(async () => (await fetch('/api/ping')).status);
  check('after sign-out the API refuses the browser (401)', afterLogout === 401, String(afterLogout));
  // The desktop's own 401 handler (e.g. a widget poll) may already be navigating to the sign-in page.
  await page.goto(`${ORIGIN}/`).catch(() => {});
  await page.waitForSelector('#key', { timeout: 15000 }).catch(() => {});
  check(`after sign-out, navigation shows the sign-in page${swActive ? ' (service worker active, not served from cache)' : ''}`, await page.locator('form[action="/login"]').count() === 1);
  const oldCookieWs = await wsUpgrade({ cookie: cookieHeader, origin: ORIGIN });
  check('a copied cookie is dead after sign-out (WebSocket 401)', oldCookieWs.status === 401, String(oldCookieWs.status));
  await page.fill('#key', KEY);
  await Promise.all([page.waitForURL(`${ORIGIN}/`), page.click('button[type=submit]')]);
  await page.waitForFunction(() => window.ltf?.wm, null, { timeout: 20000 });
  check('signing back in restores the desktop and local data', await page.evaluate(() => localStorage.getItem('ltf:beta-check') === 'kept'));

  // ── "Keep me signed in" and "Erase & sign out" ──
  await page.evaluate(() => fetch('/logout', { method: 'POST' }));
  // The desktop's own 401 handler may already be navigating to the sign-in page.
  await page.goto(`${ORIGIN}/`).catch(() => {});
  await page.waitForSelector('#key', { timeout: 15000 });
  await page.fill('#key', KEY);
  await page.check('input[name="remember"]');
  await Promise.all([page.waitForURL(`${ORIGIN}/`), page.click('button[type=submit]')]);
  await page.waitForFunction(() => window.ltf?.wm, null, { timeout: 20000 });
  const kept = (await ctx.cookies()).find((c) => c.name === '__Host-orion_session');
  const days = kept ? (kept.expires - Date.now() / 1000) / 86400 : 0;
  check('"Keep me signed in" gives a persistent cookie (~7 days)', days > 6.9 && days < 7.1, String(days));
  const cachesBefore = await page.evaluate(async () => (await caches.keys()).length);
  await page.evaluate(() => fetch('/logout?erase=1', { method: 'POST' }));
  // The desktop navigates itself to the sign-in page on the next 401; check from there (same origin).
  await page.goto(`${ORIGIN}/`).catch(() => {});
  await page.waitForSelector('#key', { timeout: 15000 }).catch(() => {});
  check('…and leaves the browser at the sign-in page', await page.locator('form[action="/login"]').count() === 1);
  const erased = await page.evaluate(async () => ({
    ls: localStorage.getItem('ltf:beta-check'),
    caches: (await caches.keys()).length,
    sw: (await navigator.serviceWorker.getRegistrations()).length,
  }));
  check('"Erase & sign out" deletes this browser\'s Orion data (localStorage, caches, service worker)', erased.ls === null && erased.caches === 0 && erased.sw === 0, `${JSON.stringify(erased)} (caches before: ${cachesBefore})`);
  const serverFile = await rawHttps({ pathName: '/healthz' });
  check('server-side data is untouched by a browser erase', serverFile.status === 200 && fs.existsSync(path.join(dataDir, 'files', 'beta-check.txt')));

  // ── Secrets never leak ──
  await sleep(300);
  const accessLog = fs.existsSync(path.join(work, 'proxy-access.log')) ? fs.readFileSync(path.join(work, 'proxy-access.log'), 'utf8') : '';
  check('access key never appears in server logs (debug level)', serverLog.length > 0 && !serverLog.includes(KEY));
  check('access key never appears in proxy access logs (URLs)', !accessLog.includes(KEY) && !accessLog.includes(encodeURIComponent(KEY)));
  check('access key never appears in any requested URL', !requestedUrls.some((u) => u.includes(KEY) || u.includes(encodeURIComponent(KEY))));
  check('WebSocket frames contain no key', !shellSockets.flatMap((s) => s.frames).some((f) => f.includes(KEY)));

  // Expected noise: remote sites are unreachable offline, 401s are the gate
  // working (the old socket's reconnect after sign-out).
  const real = consoleErrors.filter((e) => !/net::ERR|ERR_TUNNEL|ERR_PROXY|ERR_ABORTED|ERR_NAME|Failed to load resource|youtube|google|nvidia|spotify/i.test(e)
    && !/WebSocket connection to .*\/ws' failed: HTTP Authentication failed/.test(e)
    // the browser's service-worker update check after sign-out
    && !/bad HTTP response code \(401\) was received when fetching the script/.test(e));
  check('no unexpected console errors', real.length === 0, real.join(' | '));
} catch (err) {
  fail++;
  console.log('FAIL — harness error ::', err.stack || err);
  try { console.log(fs.readFileSync(path.join(work, 'nginx-error.log'), 'utf8').slice(-2000)); } catch { /* none */ }
  console.log('server log tail:', serverLog.replaceAll(KEY, '<key>').slice(-1500));
} finally {
  await cleanup();
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
