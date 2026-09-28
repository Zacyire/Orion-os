// Visual foundation (Phase 1) — interaction checks that depend on styling.
//
//   cargo build && node tests/browser/visual.browser.mjs
//
// Self-contained: starts a throwaway Orion OS server and drives the real
// desktop in Chromium. Only behaviour that the restyle could plausibly break
// is checked here — keyboard focus visibility, focus/active window states,
// resize handles and window controls not being covered, reduced motion,
// transparency-off, light theme and layout at common school/laptop
// resolutions. Pixel-level appearance is reviewed by hand, not asserted.

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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltf-visual-test-'));
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

async function openDesktop(ctx, errors) {
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(BASE);
  await page.waitForFunction(() => window.ltf?.wm && !document.body.classList.contains('booting'), null, { timeout: 30000 });
  // Fresh browser → one-time welcome (core/entry.js); enter the desktop.
  const welcome = await page.waitForSelector('#entry-screen[data-mode="welcome"]', { timeout: 10000 }).catch(() => null);
  if (welcome) { await page.keyboard.press('Enter'); await page.waitForSelector('#entry-screen', { state: 'detached', timeout: 5000 }); }
  await page.waitForTimeout(500);
  return page;
}

try {
  await waitFor(`${BASE}/api/ping`);
  const { chromium } = await loadPlaywright();
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const errors = [];

  // ── 1280×720 (smallest target) ──
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await openDesktop(ctx, errors);

  const tokens = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return ['--glass-float', '--glass-window', '--elev-4', '--focus-outline', '--accent-gradient'].map((n) => [n, cs.getPropertyValue(n).trim()]);
  });
  check('shell tokens resolve at runtime', tokens.every(([, v]) => v.length > 0), JSON.stringify(tokens));

  // Keyboard focus is visible on desktop icons and dock items (and not on mouse click).
  await page.click('.desk-icon');
  const mouseFocus = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  await page.keyboard.press('Tab');
  const kbFocus = await page.evaluate(() => { const e = document.activeElement; const cs = getComputedStyle(e); return { cls: e.className, outline: cs.outlineStyle, width: cs.outlineWidth }; });
  check('keyboard focus shows a visible outline on desktop icons', kbFocus.cls.includes('desk-icon') && kbFocus.outline === 'solid' && parseFloat(kbFocus.width) >= 2, JSON.stringify(kbFocus));
  check('mouse click does not leave a focus outline', mouseFocus === 'none', mouseFocus);
  await page.focus('#start-btn');
  await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
  const dockFocus = await page.evaluate(() => { const e = document.activeElement; return { id: e.id, outline: getComputedStyle(e).outlineStyle }; });
  check('keyboard focus is visible on the dock', dockFocus.id === 'start-btn' && dockFocus.outline === 'solid', JSON.stringify(dockFocus));

  // Layout at 1280×720: no page overflow; widgets clear of the dock and the icon grid.
  const layout = await page.evaluate(() => {
    const wa = document.querySelector('#workarea').getBoundingClientRect();
    const cards = [...document.querySelectorAll('#widgets > .widget')].map((w) => w.getBoundingClientRect());
    const icons = [...document.querySelectorAll('.desk-icon')].map((i) => i.getBoundingClientRect());
    const tb = document.querySelector('#taskbar').getBoundingClientRect();
    const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    return {
      overflowX: document.documentElement.scrollWidth > innerWidth,
      widgetsInside: cards.every((c) => c.bottom <= wa.bottom + 1 && c.right <= innerWidth),
      widgetsClearOfDock: cards.every((c) => !overlaps(c, tb)),
      widgetsClearOfIcons: cards.every((c) => icons.every((i) => !overlaps(c, i))),
      count: cards.length,
    };
  });
  check('1280×720: no horizontal page overflow', !layout.overflowX);
  check('1280×720: all three widgets fit inside the work area, clear of the dock', layout.count === 3 && layout.widgetsInside && layout.widgetsClearOfDock, JSON.stringify(layout));
  check('1280×720: widgets never cover desktop icons', layout.widgetsClearOfIcons);

  // Window chrome: focused vs unfocused states, controls and resize handles reachable.
  await page.evaluate(async () => { await window.ltf.wm.open('settings'); await window.ltf.wm.open('notepad'); });
  await page.waitForTimeout(500);
  const chrome = await page.evaluate(() => {
    const focused = document.querySelector('.window.focused');
    const other = document.querySelector('.window:not(.focused)');
    const hit = (el) => { const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const at = document.elementFromPoint(x, y); return at === el || el.contains(at); };
    const bg = getComputedStyle(focused).backgroundColor;
    return {
      shadowsDiffer: getComputedStyle(focused).boxShadow !== getComputedStyle(other).boxShadow,
      titleDimmed: getComputedStyle(other.querySelector('.win-titlebar')).color !== getComputedStyle(focused.querySelector('.win-titlebar')).color,
      controlsHit: ['.win-min', '.win-max', '.win-close'].every((s) => hit(focused.querySelector(s))),
      handlesHit: ['se', 'sw', 'ne', 'e', 's'].every((d) => hit(focused.querySelector(`.win-resize[data-dir="${d}"]`))),
      alpha: Number((bg.match(/rgba?\(([^)]+)\)/)?.[1].split(',')[3] ?? '1').trim()),
    };
  });
  check('focused and unfocused windows are visually distinct (elevation + title)', chrome.shadowsDiffer && chrome.titleDimmed, JSON.stringify(chrome));
  check('window controls are not covered by other layers', chrome.controlsHit);
  check('resize handles are not covered by other layers', chrome.handlesHit);
  check('window surface is near-solid for readability (alpha ≥ 0.9)', chrome.alpha >= 0.9, String(chrome.alpha));

  // Transparency off → no backdrop blur on the dock, widgets or windows.
  await page.evaluate(() => window.ltf.store.set('theme.transparency', false));
  await page.waitForTimeout(300);
  const blurOff = await page.evaluate(() => ['#taskbar', '.window', '.sysmon'].map((s) => getComputedStyle(document.querySelector(s)).backdropFilter));
  check('transparency off removes backdrop blur', blurOff.every((v) => v === 'none' || /blur\(0px\)/.test(v)), JSON.stringify(blurOff));
  await page.evaluate(() => window.ltf.store.set('theme.transparency', true));

  // Light theme flips the text hierarchy.
  await page.evaluate(() => window.ltf.store.set('theme.mode', 'light'));
  await page.waitForTimeout(300);
  const light = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, text: getComputedStyle(document.body).color }));
  const [r, g, b] = light.text.match(/\d+/g).map(Number);
  check('light theme uses dark text', light.theme === 'light' && r + g + b < 200, JSON.stringify(light));
  await page.evaluate(() => window.ltf.store.set('theme.mode', 'dark'));
  await ctx.close();

  // ── Reduced motion (OS preference) ──
  const rctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, reducedMotion: 'reduce' });
  const rpage = await openDesktop(rctx, errors);
  await rpage.evaluate(() => window.ltf.wm.open('notepad'));
  await rpage.waitForTimeout(200);
  const motion = await rpage.evaluate(() => {
    const w = getComputedStyle(document.querySelector('.window'));
    const card = getComputedStyle(document.querySelector('.sysmon'));
    return { win: w.animationDuration, winT: w.transitionDuration, card: card.animationDuration };
  });
  const tiny = (v) => v.split(',').every((d) => parseFloat(d) <= 0.001);
  check('reduced motion: window and widget animations are effectively instant', tiny(motion.win) && tiny(motion.winT) && tiny(motion.card), JSON.stringify(motion));
  await rctx.close();

  // ── Narrow window (900px) degrades without overflow ──
  const nctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const npage = await openDesktop(nctx, errors);
  const narrow = await npage.evaluate(() => ({
    overflowX: document.documentElement.scrollWidth > innerWidth,
    widgetW: Math.round(document.querySelector('#widgets > .widget').getBoundingClientRect().width),
    dockInside: document.querySelector('#taskbar').getBoundingClientRect().right <= innerWidth,
  }));
  check('900px wide: no overflow, narrower widget column, dock inside the viewport', !narrow.overflowX && narrow.widgetW <= 240 && narrow.dockInside, JSON.stringify(narrow));
  await nctx.close();

  const real = errors.filter((e) => !/net::ERR|Failed to load resource/.test(e));
  check('no console errors', real.length === 0, real.join(' | '));
} catch (err) {
  fail++;
  console.log('FAIL — harness error ::', err.stack || err);
} finally {
  await cleanup();
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
