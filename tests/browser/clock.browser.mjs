// Clock widget — deterministic browser tests.
//
//   cargo build && node tests/browser/clock.browser.mjs
//
// Self-contained and offline: a throwaway LTF OS server plus Playwright's Clock
// API (installed with a fixed time before load) so time behaviour — live ticks,
// single-timer cadence, midnight roll-over, teardown — is deterministic without
// waiting real seconds. Playwright is resolved locally or from `npm root -g`
// (override with CHROMIUM_PATH).

import { spawn, execSync } from 'node:child_process';
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

const bin = process.env.LTF_BIN || path.join(REPO, 'target/debug/ltf-os');
if (!fs.existsSync(bin)) { console.error(`binary not found at ${bin} — run \`cargo build\` or set LTF_BIN`); process.exit(2); }
const port = await freePort();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltf-clock-test-'));
// Disable the netcheck so the Network widget has no outbound dependency here.
const server = spawn(bin, [], {
  cwd: REPO,
  env: { ...process.env, PORT: String(port), LTF_DATA_DIR: dataDir, LTF_STATIC_DIR: path.join(REPO, 'static'), LTF_CONTENT_DIR: path.join(REPO, 'content'), LTF_NETCHECK_URL: '' },
  stdio: 'ignore',
});
const BASE = `http://127.0.0.1:${port}`;

let browser;
async function cleanup() {
  await browser?.close().catch(() => {});
  if (server.exitCode === null) { const done = new Promise((r) => server.once('exit', r)); server.kill(); await Promise.race([done, new Promise((r) => setTimeout(r, 3000))]); }
  fs.rmSync(dataDir, { recursive: true, force: true });
}

const C = '#widgets .widget[data-widget="clock"]';
const readClock = (page) => page.evaluate((sel) => ({
  time: document.querySelector(sel + ' .clock-time')?.textContent,
  date: document.querySelector(sel + ' .clock-date')?.textContent,
  datetime: document.querySelector(sel + ' .clock-time')?.getAttribute('datetime'),
  aria: document.querySelector(sel + ' .clock-time')?.getAttribute('aria-label'),
}), C);
// Format a given epoch ms exactly as the widget does, inside the page (same
// locale/timezone/Intl as the widget) — so the test never hard-codes a format.
const expected = (page, epochMs) => page.evaluate((ms) => {
  const d = new Date(ms);
  return {
    time: d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true }),
    date: d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }),
  };
}, epochMs);

try {
  await waitFor(`${BASE}/api/ping`);
  const { chromium } = await loadPlaywright();
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await (await browser.newContext()).newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  // The fake clock keeps running while the page loads, and load time varies,
  // so assertions never depend on it: install well before midnight, let the
  // desktop boot, then pauseAt() jumps to START (firing the due tick once) and
  // freezes time. From there every check is deterministic.
  const START = new Date(2026, 8, 24, 23, 59, 58); // Thu 23:59:58 local (month 8 = September)
  await page.clock.install({ time: new Date(2026, 8, 24, 23, 0, 0) });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.ltf?.wm, null, { timeout: 15000 });

  // mount + shows a time and a date
  await page.waitForSelector(C, { timeout: 8000 });
  check('clock widget mounts into #widgets', await page.$(C) !== null);
  await page.clock.pauseAt(START);
  const first = await readClock(page);
  const exp0 = await expected(page, START.getTime());
  check('displays a time', !!first.time && first.time.length > 0, JSON.stringify(first));
  check('displays a date', !!first.date && first.date.length > 0, JSON.stringify(first));
  check('time matches the browser local time', first.time === exp0.time, `${first.time} vs ${exp0.time}`);
  check('date matches the browser local date', first.date === exp0.date, `${first.date} vs ${exp0.date}`);
  check('accessible <time> with datetime + aria-label', first.datetime && first.aria?.includes(first.time) && first.aria?.includes(first.date), JSON.stringify(first));

  // live update: one render per second, single timer (count text mutations).
  // START is 23:59:58, so these 3 ticks also carry the clock across midnight.
  await page.evaluate((sel) => {
    window.__clockTicks = 0;
    const el = document.querySelector(sel + ' .clock-time');
    new MutationObserver(() => { window.__clockTicks++; }).observe(el, { childList: true, characterData: true, subtree: true });
  }, C);
  await page.clock.runFor(3000); // 23:59:59 → 00:00:00 → 00:00:01
  const ticks = await page.evaluate(() => window.__clockTicks);
  check('updates once per second (single timer, no duplicates)', ticks === 3, `ticks=${ticks} (expected 3)`);
  const after3 = await readClock(page);
  const exp3 = await expected(page, START.getTime() + 3000);
  check('displayed time advanced with the clock', after3.time === exp3.time, `${after3.time} vs ${exp3.time}`);
  check('crosses midnight: date rolls over to the next day', after3.date === exp3.date && after3.date !== first.date, `${first.date} → ${after3.date}`);

  // teardown clears the timer
  await page.evaluate(async () => { (await import('/js/core/widgets.js')).widgets.destroyAll(); });
  check('teardown removes the widget from the DOM', await page.$(C) === null);
  await page.clock.runFor(5000);
  const stillGone = await page.$(C) === null;
  check('no timer keeps firing after teardown', stillGone);
  // re-mount is clean (single widget, no duplicate timers from the old one)
  await page.evaluate(async () => { (await import('/js/core/widgets.js')).widgets.init(); });
  await page.waitForSelector(C, { timeout: 8000 });
  const count = await page.evaluate(() => document.querySelectorAll('#widgets .widget[data-widget="clock"]').length);
  check('re-mount yields exactly one clock widget', count === 1, `count=${count}`);
  // The clock is still paused, so no timer can have fired: a correct value here
  // can only come from the synchronous render at mount.
  const remount = await readClock(page);
  const expNow = await expected(page, START.getTime() + 3000 + 5000);
  check('renders immediately on mount (no timer needed)', remount.time === expNow.time && remount.date === expNow.date, `${JSON.stringify(remount)} vs ${JSON.stringify(expNow)}`);

  // coexistence: all three widgets present, System Monitor + Network still live
  const widgetOrder = await page.evaluate(() => [...document.querySelectorAll('#widgets > .widget')].map((w) => w.dataset.widget));
  check('all three widgets coexist in order [clock, sysmon, netmon]', JSON.stringify(widgetOrder) === '["clock","sysmon","netmon"]', JSON.stringify(widgetOrder));
  await page.waitForFunction(() => document.querySelector('.sysmon-status')?.textContent === 'Live', null, { timeout: 8000 });
  check('System Monitor widget still works', true);
  await page.waitForFunction(() => ['online', 'offline'].includes(document.querySelector('.netmon-dot')?.dataset.kind), null, { timeout: 8000 });
  check('Network widget still works', true);
  // no overlap: widget boxes don't intersect
  const overlap = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('#widgets > .widget')].map((w) => w.getBoundingClientRect());
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) return true;
    }
    return false;
  });
  check('widgets do not overlap', !overlap);

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
