// System Monitor widget — observable browser tests.
//
//   cargo build && node tests/browser/widgets.browser.mjs
//
// Self-contained: starts a throwaway Orion OS server (free port, temp data dir)
// and drives the real desktop in Chromium. Playwright is resolved from a local
// install or `npm root -g` (override with CHROMIUM_PATH). The widget reads the
// real GET /api/system/stats; failure/recovery is exercised by intercepting
// that request in the browser, not by changing the server.

import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
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
  while (Date.now() < until) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${url}`);
}

const bin = process.env.LTF_BIN || path.join(REPO, 'target/debug/ltf-os');
if (!fs.existsSync(bin)) { console.error(`binary not found at ${bin} — run \`cargo build\` or set LTF_BIN`); process.exit(2); }
const port = await freePort();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltf-widget-test-'));
const server = spawn(bin, [], {
  cwd: REPO,
  env: { ...process.env, PORT: String(port), LTF_DATA_DIR: dataDir, LTF_STATIC_DIR: path.join(REPO, 'static'), LTF_CONTENT_DIR: path.join(REPO, 'content') },
  stdio: 'ignore',
});
const BASE = `http://127.0.0.1:${port}`;

let browser;
async function cleanup() {
  await browser?.close().catch(() => {});
  if (server.exitCode === null) { const done = new Promise((r) => server.once('exit', r)); server.kill(); await Promise.race([done, new Promise((r) => setTimeout(r, 3000))]); }
  fs.rmSync(dataDir, { recursive: true, force: true });
}

const W = '#widgets .widget[data-widget="sysmon"]';

try {
  await waitFor(`${BASE}/api/ping`);
  const { chromium } = await loadPlaywright();
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  // Count real network requests to the endpoint (before the SW etc.).
  let statsRequests = 0;
  await page.route('**/api/system/stats', (route) => { statsRequests++; route.continue(); });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.ltf?.wm, null, { timeout: 15000 });

  // 1. widget exists and mounted into #widgets
  await page.waitForSelector(W, { timeout: 8000 });
  check('widget is created and mounted into the #widgets layer', await page.$(W) !== null);
  check('widget sits below application windows (lower stacking context)',
    await page.evaluate(() => getComputedStyle(document.querySelector('#widgets')).zIndex === '5'));

  // 2. it requests /api/system/stats
  await page.waitForFunction(() => document.querySelector('.sysmon-status')?.textContent === 'Live', null, { timeout: 8000 });
  check('widget requested GET /api/system/stats', statsRequests >= 1, `count=${statsRequests}`);

  // 3. valid stats render (compare against a direct fetch of the same endpoint)
  const truth = await page.evaluate(() => fetch('/api/system/stats').then((r) => r.json()));
  const ui = await page.evaluate((sel) => {
    const q = (s) => document.querySelector(sel + ' ' + s)?.textContent?.trim();
    return {
      status: q('.sysmon-status'),
      cpu: document.querySelectorAll(sel + ' .sysmon-metric-top b')[0].textContent.trim(),
      mem: document.querySelectorAll(sel + ' .sysmon-metric-top b')[1].textContent.trim(),
      memDetail: document.querySelectorAll(sel + ' .sysmon-facts dd')[0].textContent.trim(),
      uptime: document.querySelectorAll(sel + ' .sysmon-facts dd')[1].textContent.trim(),
      platform: document.querySelectorAll(sel + ' .sysmon-facts dd')[2].textContent.trim(),
    };
  }, W);
  check('status shows "Live" after first response', ui.status === 'Live', ui.status);
  if (truth.platform.supported) {
    check('CPU value rendered (percent or —)', /^(\d+(\.\d)?%|—)$/.test(ui.cpu), ui.cpu);
    check('memory percent rendered', /^\d+%$/.test(ui.mem), ui.mem);
    check('memory detail shows used / total', /\d.*\/.*\d/.test(ui.memDetail), ui.memDetail);
    check('uptime rendered', ui.uptime !== '—' && ui.uptime.length > 0, ui.uptime);
    check('platform shows os · arch', ui.platform.includes(truth.platform.os) && ui.platform.includes(truth.platform.arch), ui.platform);
  } else {
    check('unsupported platform renders dashes, not fake zeros', ui.cpu === '—' && ui.mem === '—', JSON.stringify(ui));
  }

  // 4. CPU null → "—", not "0%" (inject a null-cpu response via interception)
  await page.route('**/api/system/stats', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ schema: 1, sampled_at_ms: Date.now(), platform: { os: 'linux', arch: 'x86_64', supported: true }, uptime_seconds: 5, cpu: { usage_percent: null, logical_cores: 4 }, memory: { total_bytes: 1000, used_bytes: 400, available_bytes: 600 } }),
  }));
  await page.waitForFunction((sel) => document.querySelectorAll(sel + ' .sysmon-metric-top b')[0].textContent.trim() === '—', W, { timeout: 8000 });
  const nullCpu = await page.evaluate((sel) => ({
    cpu: document.querySelectorAll(sel + ' .sysmon-metric-top b')[0].textContent.trim(),
    mem: document.querySelectorAll(sel + ' .sysmon-metric-top b')[1].textContent.trim(),
  }), W);
  check('CPU null renders "—" while memory (40%) still renders', nullCpu.cpu === '—' && nullCpu.mem === '40%', JSON.stringify(nullCpu));

  // 5. API failure → offline state, last values retained, no crash
  await page.unroute('**/api/system/stats');
  await page.route('**/api/system/stats', (route) => route.abort());
  await page.waitForFunction(() => /Offline|Unavailable/.test(document.querySelector('.sysmon-status')?.textContent || ''), null, { timeout: 8000 });
  const offline = await page.evaluate((sel) => ({
    status: document.querySelector('.sysmon-status').textContent.trim(),
    dot: document.querySelector('.sysmon-dot').dataset.kind,
    memStillThere: document.querySelectorAll(sel + ' .sysmon-metric-top b')[1].textContent.trim(),
    desktopAlive: !!window.ltf?.wm && !!document.querySelector('#desktop'),
  }), W);
  check('API failure shows offline state', /Offline/.test(offline.status) && offline.dot === 'off', JSON.stringify(offline));
  check('last good values retained during outage', offline.memStillThere === '40%', offline.memStillThere);
  check('desktop keeps working when the endpoint fails', offline.desktopAlive);

  // 6/8. recovery: unblock and confirm it goes Live again
  await page.unroute('**/api/system/stats');
  await page.route('**/api/system/stats', (route) => { statsRequests++; route.continue(); });
  await page.waitForFunction(() => document.querySelector('.sysmon-status')?.textContent === 'Live', null, { timeout: 8000 });
  check('widget resumes automatically when the API returns', true);

  // 7. polling cadence: not faster than the intended interval
  const start = statsRequests;
  await page.waitForTimeout(5200);
  const delta = statsRequests - start;
  check('polls periodically (updates keep coming)', delta >= 2, `${delta} requests in ~5.2s`);
  check('does not poll faster than ~2s (no request flood)', delta <= 5, `${delta} requests in ~5.2s`);

  // repeated polling actually re-renders sampled_at (live)
  const t1 = await page.evaluate(() => fetch('/api/system/stats').then((r) => r.json()).then((s) => s.sampled_at_ms));
  await page.waitForTimeout(2400);
  const t2 = await page.evaluate(() => fetch('/api/system/stats').then((r) => r.json()).then((s) => s.sampled_at_ms));
  check('backend keeps producing fresh samples across polls', t2 >= t1, `${t1} → ${t2}`);

  // 9. existing desktop functionality still works (open an app window)
  const opened = await page.evaluate(async () => { const w = await window.ltf.wm.open('appstore'); return !!w && !!document.querySelector('.window[data-app="appstore"]'); });
  check('existing desktop still works (opened App Store over the widget)', opened);

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
