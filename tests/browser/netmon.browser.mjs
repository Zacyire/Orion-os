// Network Status widget — observable browser tests.
//
//   cargo build && node tests/browser/netmon.browser.mjs
//
// Self-contained and offline: starts a throwaway Orion OS server pointed at a
// LOCAL mock connectivity target (LTF_NETCHECK_URL), so the real
// /api/network/stats returns online without touching the public internet.
// Offline / null-latency / API-failure states are exercised with in-browser
// request interception. Playwright is resolved locally or from `npm root -g`
// (override with CHROMIUM_PATH).

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

// Local mock connectivity target for the server-side probe.
const target = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/plain' }); r.end('ok'); });
await new Promise((r) => target.listen(0, '127.0.0.1', r));
const NETCHECK = `http://127.0.0.1:${target.address().port}/`;

const bin = process.env.LTF_BIN || path.join(REPO, 'target/debug/ltf-os');
if (!fs.existsSync(bin)) { console.error(`binary not found at ${bin} — run \`cargo build\` or set LTF_BIN`); process.exit(2); }
const port = await freePort();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltf-netmon-test-'));
const server = spawn(bin, [], {
  cwd: REPO,
  env: { ...process.env, PORT: String(port), LTF_DATA_DIR: dataDir, LTF_STATIC_DIR: path.join(REPO, 'static'), LTF_CONTENT_DIR: path.join(REPO, 'content'), LTF_NETCHECK_URL: NETCHECK },
  stdio: 'ignore',
});
const BASE = `http://127.0.0.1:${port}`;

let browser;
async function cleanup() {
  await browser?.close().catch(() => {});
  if (server.exitCode === null) { const done = new Promise((r) => server.once('exit', r)); server.kill(); await Promise.race([done, new Promise((r) => setTimeout(r, 3000))]); }
  target.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

const N = '#widgets .widget[data-widget="netmon"]';
const read = (page) => page.evaluate((sel) => ({
  dot: document.querySelector(sel + ' .netmon-dot')?.dataset.kind,
  label: document.querySelector(sel + ' .netmon-label')?.textContent?.trim(),
  value: document.querySelector(sel + ' .netmon-value')?.textContent?.trim(),
}), N);

try {
  await waitFor(`${BASE}/api/ping`);
  const { chromium } = await loadPlaywright();
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await (await browser.newContext()).newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  let netRequests = 0;
  await page.route('**/api/network/stats', (r) => { netRequests++; r.continue(); });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.ltf?.wm, null, { timeout: 15000 });

  // mount + requests the endpoint
  await page.waitForSelector(N, { timeout: 8000 });
  check('network widget mounts into #widgets', await page.$(N) !== null);
  await page.waitForFunction((sel) => document.querySelector(sel + ' .netmon-dot')?.dataset.kind === 'online', N, { timeout: 8000 });
  check('widget requested GET /api/network/stats', netRequests >= 1, `count=${netRequests}`);

  // online state (real backend, real local probe)
  const online = await read(page);
  check('online state renders (green dot, "Online")', online.dot === 'online' && online.label === 'Online', JSON.stringify(online));
  check('latency renders as "N ms"', /^\d+ ms$/.test(online.value), online.value);
  const truth = await page.evaluate(() => fetch('/api/network/stats').then((r) => r.json()));
  check('backend reports online:true with numeric latency', truth.online === true && typeof truth.latency_ms === 'number', JSON.stringify(truth));

  // online but latency null → value "—", still "Online"
  await page.route('**/api/network/stats', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ schema: 1, sampled_at_ms: Date.now(), online: true, latency_ms: null }) }));
  await page.waitForFunction((sel) => document.querySelector(sel + ' .netmon-value')?.textContent.trim() === '—' && document.querySelector(sel + ' .netmon-dot')?.dataset.kind === 'online', N, { timeout: 8000 });
  const nullLat = await read(page);
  check('latency_ms null renders "—" while still Online', nullLat.dot === 'online' && nullLat.label === 'Online' && nullLat.value === '—', JSON.stringify(nullLat));

  // backend-reported offline → distinct state
  await page.unroute('**/api/network/stats');
  await page.route('**/api/network/stats', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ schema: 1, sampled_at_ms: Date.now(), online: false, latency_ms: null }) }));
  await page.waitForFunction((sel) => document.querySelector(sel + ' .netmon-dot')?.dataset.kind === 'offline', N, { timeout: 8000 });
  const off = await read(page);
  check('backend offline renders distinctly (red dot, "Offline", "—")', off.dot === 'offline' && off.label === 'Offline' && off.value === '—', JSON.stringify(off));

  // API failure (transport) → distinct from backend offline; last value kept; desktop alive
  await page.unroute('**/api/network/stats');
  await page.route('**/api/network/stats', (r) => r.abort());
  await page.waitForFunction((sel) => document.querySelector(sel + ' .netmon-dot')?.dataset.kind === 'transport', N, { timeout: 8000 });
  const trans = await read(page);
  const desktopAlive = await page.evaluate(() => !!window.ltf?.wm && !!document.querySelector('#desktop'));
  check('API failure shows "Offline · retrying" (transport state, amber)', trans.dot === 'transport' && /retrying/.test(trans.label), JSON.stringify(trans));
  check('transport failure is distinct from backend offline', trans.dot !== 'offline');
  check('desktop stays alive when the API request fails', desktopAlive);

  // recovery back to online
  await page.unroute('**/api/network/stats');
  await page.route('**/api/network/stats', (r) => { netRequests++; r.continue(); });
  await page.waitForFunction((sel) => document.querySelector(sel + ' .netmon-dot')?.dataset.kind === 'online', N, { timeout: 8000 });
  check('widget recovers automatically when the API returns', (await read(page)).label === 'Online');

  // polling cadence (~3s): not a flood, and updates keep coming
  const start = netRequests;
  await page.waitForTimeout(6500);
  const delta = netRequests - start;
  check('polls periodically', delta >= 1, `${delta} in ~6.5s`);
  check('does not overlap / flood (<= ~4 in ~6.5s)', delta <= 4, `${delta} in ~6.5s`);

  // existing System Monitor widget still works alongside it
  await page.waitForFunction(() => document.querySelector('#widgets .widget[data-widget="sysmon"] .sysmon-status')?.textContent === 'Live', null, { timeout: 8000 });
  check('existing System Monitor widget still works', true);
  check('System Monitor and Network widgets coexist in the #widgets column', await page.evaluate(() => {
    const ids = [...document.querySelectorAll('#widgets > .widget')].map((w) => w.dataset.widget);
    return ids.includes('sysmon') && ids.includes('netmon');
  }));

  const real = consoleErrors.filter((e) => !/net::ERR|ERR_TUNNEL|ERR_PROXY|ERR_ABORTED|Failed to load resource/.test(e));
  check('no unexpected console errors', real.length === 0, real.join(' | '));
} catch (err) {
  fail++;
  console.log('FAIL — harness error ::', err.stack || err);
} finally {
  await cleanup();
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
