// Boot splash, first-entry welcome and local lock screen (Phase 2).
//
//   cargo build && node tests/browser/entry.browser.mjs
//
// Self-contained: a throwaway Orion OS server plus a plain static file server
// (the "static edition" case, no /api at all), driven in Chromium.
//
// Leak checks are black-box: an init script counts active setInterval timers
// and window/document keydown listeners (with the file that registered them),
// so no debug hooks are added to the app. Timeline checks use the splash's
// own performance marks (orion-boot-start / -ready / -end).

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

const bin = process.env.LTF_BIN || path.join(REPO, 'target/debug/ltf-os');
if (!fs.existsSync(bin)) { console.error(`binary not found at ${bin} — run \`cargo build\` or set LTF_BIN`); process.exit(2); }
const port = await freePort();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltf-entry-test-'));
const server = spawn(bin, [], {
  cwd: REPO,
  env: { ...process.env, PORT: String(port), LTF_DATA_DIR: dataDir, LTF_STATIC_DIR: path.join(REPO, 'static'), LTF_CONTENT_DIR: path.join(REPO, 'content'), LTF_NETCHECK_URL: '' },
  stdio: 'ignore',
});
const BASE = `http://127.0.0.1:${port}`;

// Static edition: static/ served by a plain file server — no Rust, no /api.
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm' };
const staticRoot = path.join(REPO, 'static');
const staticServer = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(staticRoot, path.normalize(p));
  if (!file.startsWith(staticRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => staticServer.listen(0, '127.0.0.1', r));
const STATIC = `http://127.0.0.1:${staticServer.address().port}`;

let browser;
async function cleanup() {
  await browser?.close().catch(() => {});
  if (server.exitCode === null) { const done = new Promise((r) => server.once('exit', r)); server.kill(); await Promise.race([done, new Promise((r) => setTimeout(r, 3000))]); }
  staticServer.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

// Counts active intervals and keydown listeners, remembering which script registered each.
const INSTRUMENT = () => {
  const src = () => (new Error().stack || '').split('\n').slice(2).find((l) => /\/js\//.test(l)) || '';
  const intervals = new Map();
  const _si = window.setInterval, _ci = window.clearInterval;
  window.setInterval = function (...a) { const id = _si.apply(this, a); intervals.set(id, src()); return id; };
  window.clearInterval = function (id) { intervals.delete(id); return _ci.call(this, id); };
  const listeners = new Set();
  const key = (t, fn, o) => `${t === window ? 'w' : 'd'}|${!!(o === true || o?.capture)}|${fn && (fn.__id ??= Math.random())}`;
  for (const target of [window, document]) {
    const add = target.addEventListener.bind(target), rem = target.removeEventListener.bind(target);
    target.addEventListener = (type, fn, o) => { if (type === 'keydown') listeners.add(`${key(target, fn, o)}|${src()}`); return add(type, fn, o); };
    target.removeEventListener = (type, fn, o) => { if (type === 'keydown') for (const k of listeners) if (k.startsWith(key(target, fn, o) + '|')) listeners.delete(k); return rem(type, fn, o); };
  }
  window.__probe = () => ({
    intervals: [...intervals.values()],
    keydown: [...listeners].map((k) => k.split('|').slice(3).join('|')),
  });
};

const marks = (page) => page.evaluate(() => Object.fromEntries(['orion-boot-start', 'orion-boot-ready', 'orion-boot-end']
  .map((n) => [n.replace('orion-boot-', ''), Math.round(performance.getEntriesByName(n)[0]?.startTime ?? -1)])));
const bootEnded = (page, timeout = 30000) => page.waitForFunction(() => performance.getEntriesByName('orion-boot-end').length > 0, null, { timeout });
const overlayState = (page) => page.evaluate(() => ({
  boot: !!document.getElementById('boot'),
  booting: document.body.classList.contains('booting'),
  entry: document.querySelectorAll('#entry-screen').length,
  mode: document.querySelector('#entry-screen')?.dataset.mode ?? null,
  inert: document.querySelector('#shell').inert,
  entryOpen: document.body.classList.contains('entry-open'),
}));

try {
  await waitFor(`${BASE}/api/ping`);
  const { chromium } = await loadPlaywright();
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const errors = [];
  const newPage = async (opts = {}, url = BASE, { instrument = true, seen = false, sink = errors } = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, ...opts });
    if (instrument) await ctx.addInitScript(INSTRUMENT);
    if (seen) await ctx.addInitScript(() => localStorage.setItem('ltf:entry', JSON.stringify({ seen: 1 })));
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') sink.push(m.text()); });
    page.on('pageerror', (e) => sink.push('pageerror: ' + e.message));
    return { ctx, page };
  };

  // ── 1–2. First visit: splash renders, reports real steps, completes ──
  {
    const { ctx, page } = await newPage();
    await page.addInitScript(() => {
      window.__bootSeen = { statuses: [], values: [] };
      new MutationObserver(() => {
        const s = document.getElementById('boot-status')?.textContent;
        const v = document.querySelector('#boot .boot-progress')?.getAttribute('aria-valuenow');
        const log = window.__bootSeen;
        if (s && log.statuses.at(-1) !== s) log.statuses.push(s);
        if (v && log.values.at(-1) !== v) log.values.push(v);
      }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    });
    await page.goto(BASE, { waitUntil: 'commit' });
    await page.waitForSelector('#boot .boot-title', { timeout: 10000 });
    const splash = await page.evaluate(() => ({ title: document.querySelector('#boot .boot-title').textContent.replace(/\s+/g, ' ').trim(), text: document.getElementById('boot').textContent, skip: !!document.getElementById('boot-skip') }));
    check('boot splash renders with Orion branding and a visible Skip (Esc) control', splash.title === 'Orion OS' && splash.skip, JSON.stringify(splash));
    check('splash contains no simulated kernel/hardware output', !/kernel|systemd|linux|fsck|nvme|acpi|ramdisk/i.test(splash.text), splash.text.slice(0, 120));
    await bootEnded(page);
    const seen = await page.evaluate(() => window.__bootSeen);
    // (Synchronous steps such as "Preparing the desktop" can be replaced within one frame, so only the awaited steps are asserted.)
    check('splash status reports the real startup steps', ['Loading your preferences', 'Loading apps', 'Loading wallpaper', 'Ready'].every((s) => seen.statuses.includes(s)), JSON.stringify(seen.statuses));
    check('progress reaches 100% before the splash leaves', seen.values.includes('100'), JSON.stringify(seen.values));
    const m = await marks(page);
    check('first-visit splash is short (≤ ~1.6 s from start to removal)', m.end - m.start <= 1700 && m.end >= m.ready, JSON.stringify(m));
    const st = await overlayState(page);
    check('boot completes: splash removed, desktop no longer booting', !st.boot && !st.booting, JSON.stringify(st));
    // 6 (welcome). First visit → one-time welcome over the live desktop.
    await page.waitForSelector('#entry-screen[data-mode="welcome"]', { timeout: 5000 });
    const w = await page.evaluate(() => ({ focus: document.activeElement?.className, label: document.querySelector('#entry-screen').getAttribute('aria-label'), inert: document.querySelector('#shell').inert, taskbarVisible: getComputedStyle(document.querySelector('#taskbar')).visibility }));
    check('first visit shows the welcome with "Enter Orion" focused; desktop inert beneath', w.focus === 'entry-action' && w.label === 'Welcome to Orion OS' && w.inert === true, JSON.stringify(w));
    await page.keyboard.press('Enter');
    await page.waitForSelector('#entry-screen', { state: 'detached', timeout: 3000 });
    const after = await overlayState(page);
    check('Enter on the welcome enters the desktop and leaves no overlay', after.entry === 0 && !after.inert && !after.entryOpen, JSON.stringify(after));
    const leftovers = await page.evaluate(() => window.__probe());
    check('no boot/entry listeners or timers remain after entering', ![...leftovers.intervals, ...leftovers.keydown].some((s) => /boot\.js|entry\.js/.test(s)), JSON.stringify(leftovers));
    // Return visit: shorter splash, no welcome.
    await page.reload({ waitUntil: 'commit' });
    await bootEnded(page);
    await page.waitForTimeout(300);
    const r = await marks(page); const rs = await overlayState(page);
    check('return visit: shorter splash and no second welcome', r.end - r.start <= 1100 && rs.entry === 0 && !rs.boot, JSON.stringify({ ...r, ...rs }));
    await ctx.close();
  }

  // ── 3–4. Esc skips the splash immediately; nothing stale remains ──
  {
    const { ctx, page } = await newPage();
    // When the skip actually happened (keypress / click), to measure removal from it.
    await page.addInitScript(() => {
      const at = () => { window.__skipAt = performance.now(); };
      window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && window.__skipAt == null) at(); }, true);
      document.addEventListener('click', (e) => { if (e.target.closest?.('#boot-skip')) at(); }, true);
    });
    const skipLag = async () => { const m = await marks(page); const at = await page.evaluate(() => Math.round(window.__skipAt ?? -1)); return { ...m, skipAt: at, lag: m.end - Math.max(m.ready, at) }; };
    await page.goto(BASE, { waitUntil: 'commit' });
    // Esc is handled once the splash script is live (data-state is set by boot.js).
    await page.waitForSelector('#boot[data-state]');
    await page.keyboard.press('Escape');
    await bootEnded(page);
    const m = await skipLag();
    check('Esc removes the splash immediately (no minimum, no fade)', m.skipAt > 0 && m.lag <= 100, JSON.stringify(m));
    await page.waitForTimeout(400);
    const st = await overlayState(page);
    check('skipping leaves no stale splash; exactly one welcome (first visit)', !st.boot && !st.booting && st.entry === 1 && st.mode === 'welcome', JSON.stringify(st));
    await page.keyboard.press('Escape'); // Esc also continues from the welcome
    await page.waitForSelector('#entry-screen', { state: 'detached', timeout: 3000 });
    const hit = await page.evaluate(() => { const el = document.elementFromPoint(40, 40); return !!el?.closest('#desktop, .desk-icon'); });
    check('after Esc the desktop receives clicks (no invisible overlay left)', hit);
    // The Skip button works with a click too.
    await page.reload({ waitUntil: 'commit' });
    await page.waitForSelector('#boot[data-state]');
    await page.click('#boot-skip', { timeout: 5000 }).catch(() => {});
    await bootEnded(page);
    const m2 = await skipLag();
    check('the Skip button skips as well', m2.skipAt > 0 && m2.lag <= 100, JSON.stringify(m2));
    await ctx.close();
  }

  // ── 5. Reduced motion: no branded minimum, no fade, no looping animation ──
  {
    const { ctx, page } = await newPage({ reducedMotion: 'reduce' });
    await page.goto(BASE, { waitUntil: 'commit' });
    await page.waitForSelector('#boot .boot-mark');
    const anim = await page.evaluate(() => getComputedStyle(document.querySelector('#boot .boot-mark')).animationName);
    await bootEnded(page);
    const m = await marks(page);
    check('reduced motion: splash removed as soon as the real work is done', m.end - m.ready <= 60, JSON.stringify(m));
    check('reduced motion: the mark does not animate', anim === 'none', anim);
    await ctx.close();
  }

  // ── 6–10. Lock screen ──
  {
    const { ctx, page } = await newPage({}, BASE, { seen: true });
    await page.goto(BASE);
    await bootEnded(page);
    await page.waitForTimeout(300);
    check('with the welcome already seen, no welcome is shown', (await overlayState(page)).entry === 0);
    // A window with state, focused, before locking.
    await page.evaluate(() => window.ltf.wm.open('notepad'));
    await page.waitForSelector('.window[data-app="notepad"] textarea');
    await page.click('.window[data-app="notepad"] textarea');
    await page.keyboard.type('kept across the lock');
    const winId = await page.evaluate(() => document.querySelector('.window[data-app="notepad"]').dataset.id);
    const baseline = await page.evaluate(() => window.__probe());

    await page.keyboard.press('Control+Alt+KeyL');
    await page.waitForSelector('#entry-screen[data-mode="lock"]');
    const lock = await page.evaluate(() => {
      const now = new Date();
      return {
        time: document.querySelector('.entry-time').textContent,
        expected: now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
        date: document.querySelector('.entry-date').textContent,
        expectedDate: now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }),
        role: document.querySelector('#entry-screen').getAttribute('role'),
        focus: document.activeElement?.className,
        inert: document.querySelector('#shell').inert,
        text: document.querySelector('#entry-screen').textContent,
        color: getComputedStyle(document.querySelector('.entry-time')).color,
      };
    });
    check('lock screen renders the current time and date', lock.time === lock.expected && lock.date === lock.expectedDate, JSON.stringify(lock));
    check('lock screen is a modal dialog with Unlock focused and the desktop inert', lock.role === 'dialog' && lock.focus === 'entry-action' && lock.inert, JSON.stringify(lock));
    check('lock screen shows no account/session details and asks for no key', !/password|access key|sign in|session|user/i.test(lock.text), lock.text);
    const during = await page.evaluate(() => window.__probe());
    check('while locked: exactly one extra timer and one extra key listener', during.intervals.length === baseline.intervals.length + 1 && during.keydown.length === baseline.keydown.length + 1, JSON.stringify({ baseline, during }));

    // Desktop shortcuts never fire underneath the lock (Alt+W would close the window).
    await page.keyboard.press('Alt+KeyW');
    await page.keyboard.press('Control+Space');
    const shielded = await page.evaluate((id) => ({ win: !!document.querySelector(`.window[data-id="${id}"]`), locked: !!document.querySelector('#entry-screen'), start: !document.getElementById('start-menu').hidden }), winId);
    check('desktop shortcuts are blocked while locked (window kept, launcher closed)', shielded.win && shielded.locked && !shielded.start, JSON.stringify(shielded));
    check('a modified Space/Enter (e.g. Ctrl+Space) does not unlock', await page.evaluate(() => !!document.querySelector('#entry-screen[data-mode="lock"]')));
    // Tab cannot reach the inert desktop.
    await page.keyboard.press('Tab');
    const tabbed = await page.evaluate(() => !document.activeElement || !document.querySelector('#shell').contains(document.activeElement));
    check('Tab does not move focus into the covered desktop', tabbed);

    // 8. Space on the focused Unlock button unlocks.
    await page.focus('.entry-action');
    await page.keyboard.press('Space');
    await page.waitForSelector('#entry-screen', { state: 'detached', timeout: 3000 });
    // 9. Window, its content and focus survive.
    const kept = await page.evaluate((id) => {
      const w = document.querySelector(`.window[data-id="${id}"]`);
      return { exists: !!w, text: w?.querySelector('textarea')?.value, focusInWindow: !!w?.contains(document.activeElement), inert: document.querySelector('#shell').inert };
    }, winId);
    check('Space on Unlock unlocks', !kept.inert);
    check('open windows survive lock/unlock with their content', kept.exists && kept.text === 'kept across the lock', JSON.stringify(kept));
    check('focus returns to where it was before locking', kept.focusInWindow, JSON.stringify(kept));

    // Enter on Unlock, a click anywhere, and any key also unlock.
    for (const [how, act] of [
      ['Enter', async () => { await page.focus('.entry-action'); await page.keyboard.press('Enter'); }],
      ['click', async () => { await page.mouse.click(300, 300); }],
      ['any key', async () => { await page.keyboard.press('KeyK'); }],
    ]) {
      await page.keyboard.press('Control+Alt+KeyL');
      await page.waitForSelector('#entry-screen[data-mode="lock"]');
      await act();
      const gone = await page.waitForSelector('#entry-screen', { state: 'detached', timeout: 3000 }).then(() => true).catch(() => false);
      check(`${how} unlocks`, gone);
    }
    const typedK = await page.evaluate((id) => document.querySelector(`.window[data-id="${id}"] textarea`).value, winId);
    check('the unlocking keystroke is not delivered to the app underneath', typedK === 'kept across the lock', typedK);

    // 10. No accumulation after repeated cycles (and a second lock while locked is ignored).
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Control+Alt+KeyL');
      await page.waitForSelector('#entry-screen[data-mode="lock"]');
      await page.evaluate(() => import('/js/core/power.js').then((m) => m.power.lock()));
      const count = await page.evaluate(() => document.querySelectorAll('#entry-screen').length);
      if (count !== 1) { check('a second lock while locked is ignored', false, String(count)); break; }
      await page.keyboard.press('Escape');
      await page.waitForSelector('#entry-screen', { state: 'detached', timeout: 3000 });
    }
    await page.waitForTimeout(200);
    const end = await page.evaluate(() => window.__probe());
    check('no timers or key listeners accumulate over repeated lock/unlock', end.intervals.length === baseline.intervals.length && end.keydown.length === baseline.keydown.length, JSON.stringify({ baseline, end }));
    const wins = await page.evaluate(() => document.querySelectorAll('.window').length);
    check('repeated lock/unlock does not duplicate or drop windows', wins === 1, String(wins));

    // Light theme + transparency off: the lock still renders readable light text.
    await page.evaluate(() => { window.ltf.store.set('theme.mode', 'light'); window.ltf.store.set('theme.transparency', false); });
    await page.keyboard.press('Control+Alt+KeyL');
    await page.waitForSelector('#entry-screen[data-mode="lock"]');
    const lt = await page.evaluate(() => getComputedStyle(document.querySelector('.entry-time')).color);
    const [r, g, b] = lt.match(/\d+/g).map(Number);
    check('light theme + transparency off: lock text stays light on the wallpaper scrim', r + g + b > 700, lt);
    await page.keyboard.press('Escape');
    await ctx.close();
  }

  // ── 11a. Static edition: no Rust, no /api — boot must still complete ──
  {
    const staticErrors = [];
    const { ctx, page } = await newPage({}, STATIC, { instrument: false, seen: true, sink: staticErrors });
    await page.goto(STATIC);
    await bootEnded(page, 20000);
    await page.waitForTimeout(300);
    const st = await page.evaluate(() => ({ booting: document.body.classList.contains('booting'), boot: !!document.getElementById('boot'), icons: document.querySelectorAll('.desk-icon').length, dock: document.querySelectorAll('.tb-item').length }));
    check('static edition (no backend): boot completes and the desktop renders apps', !st.booting && !st.boot && st.icons > 0 && st.dock > 0, JSON.stringify(st));
    // Without a server there is no /ws (and no /api) — expected there; nothing else may fail.
    const unexpected = staticErrors.filter((e) => !/WebSocket connection to .*\/ws' failed|Failed to load resource/.test(e));
    check('static edition: no errors beyond the absent server endpoints', unexpected.length === 0, unexpected.join(' | '));
    await ctx.close();
  }

  // ── 11b. Backend unreachable: honest notice, desktop still usable ──
  {
    const { ctx, page } = await newPage({}, BASE, { instrument: false, seen: true });
    await page.route('**/api/**', (r) => r.abort());
    const notices = [];
    await page.exposeFunction('__note', (t) => notices.push(t));
    await page.addInitScript(() => new MutationObserver(() => { const s = document.getElementById('boot-status')?.textContent; if (s) window.__note(s); }).observe(document, { subtree: true, childList: true, characterData: true }));
    await page.goto(BASE);
    await bootEnded(page, 20000);
    const st = await page.evaluate(() => ({ booting: document.body.classList.contains('booting'), icons: document.querySelectorAll('.desk-icon').length }));
    check('server unreachable: the splash says so honestly', notices.some((n) => /server unavailable/i.test(n)), JSON.stringify([...new Set(notices)]));
    check('server unreachable: desktop still becomes usable', !st.booting && st.icons > 0, JSON.stringify(st));
    await ctx.close();
  }

  // ── 11c. Backend hangs (accepts but never answers): bounded by the boot timeout ──
  {
    const { ctx, page } = await newPage({}, BASE, { instrument: false, seen: true });
    await page.route('**/api/prefs', () => { /* never answer */ });
    const t0 = Date.now();
    await page.goto(BASE, { waitUntil: 'commit' });
    await bootEnded(page, 20000);
    const took = Date.now() - t0;
    const st = await page.evaluate(() => ({ booting: document.body.classList.contains('booting'), icons: document.querySelectorAll('.desk-icon').length }));
    check('a hanging server cannot hold the splash forever (bounded by the ~6 s request timeout)', !st.booting && st.icons > 0 && took < 12000, `${took} ms ${JSON.stringify(st)}`);
    await ctx.close();
  }

  const real = errors.filter((e) => !/net::ERR|Failed to load resource|ERR_ABORTED|ERR_FAILED/i.test(e));
  check('no console errors', real.length === 0, real.join(' | '));
} catch (err) {
  fail++;
  console.log('FAIL — harness error ::', err.stack || err);
} finally {
  await cleanup();
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
