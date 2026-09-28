// Beta 0.1 — Roblox, CineJoy, Vapor hub and the static edition.
//
//   cargo build && node tests/browser/beta.browser.mjs
//
// Part A drives the full edition (throwaway Rust server). Part B builds the
// real static edition with tools/build-static.sh and serves it from a plain
// file server — no Rust, no /api, no /ws — exactly what GitHub Pages serves.
// window.open is stubbed per test to record hand-offs to the user's browser;
// every page request is recorded to prove no proxy/inspect path is used.

import { spawn, execSync, execFileSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROBLOX = 'https://172.ip.nowgg.fun/apps/a/19900/b.html';
const CINEJOY = 'https://cinejoy.pk/';
const NETFLIX = 'https://www.netflix.com/';
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltf-beta-test-'));
const server = spawn(bin, [], {
  cwd: REPO,
  env: { ...process.env, PORT: String(port), LTF_DATA_DIR: dataDir, LTF_STATIC_DIR: path.join(REPO, 'static'), LTF_CONTENT_DIR: path.join(REPO, 'content'), LTF_NETCHECK_URL: '', LTF_PROXY: '0' },
  stdio: 'ignore',
});
const BASE = `http://127.0.0.1:${port}`;

// The real static edition, as GitHub Pages would serve it.
const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-beta-site-'));
execFileSync(path.join(REPO, 'tools/build-static.sh'), [siteDir], { cwd: REPO, stdio: 'ignore' });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.webm': 'video/webm', '.mp4': 'video/mp4' };
const staticServer = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(siteDir, path.normalize(p));
  if (!file.startsWith(siteDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<h1>404</h1>'); }
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
  fs.rmSync(siteDir, { recursive: true, force: true });
}

// Record window.open calls (the hand-off to the user's browser) without opening tabs.
const STUB_OPEN = () => { window.__opened = []; window.open = (...a) => { window.__opened.push(a); return null; }; };

async function desktop(url, { errors, requests }) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  await ctx.addInitScript(STUB_OPEN);
  await ctx.addInitScript(() => localStorage.setItem('ltf:entry', JSON.stringify({ seen: 1 })));
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('request', (r) => requests.push(r.url()));
  page.on('websocket', (ws) => requests.push(ws.url()));
  await page.goto(url);
  await page.waitForFunction(() => performance.getEntriesByName('orion-boot-end').length > 0, null, { timeout: 30000 });
  await page.waitForTimeout(300);
  return { ctx, page };
}

/** Open an external-runtime app and press its primary action; returns what happened. */
async function launchExternal(page, id, args) {
  return page.evaluate(async ([appId, a]) => {
    window.__opened = [];
    const w = await window.ltf.wm.open(appId, a);
    await new Promise((r) => setTimeout(r, 300));
    const el = document.querySelector(`.window[data-id="${w.id}"]`);
    const info = { iframe: !!el.querySelector('iframe'), text: el.querySelector('.frame-notice')?.textContent || '', badge: !!el.querySelector('.win-titlebar .app-icon') };
    // The primary action is a real target="_blank" link. Click it, but record
    // the navigation instead of letting the test open a tab.
    const btn = el.querySelector('.frame-actions .btn.primary');
    info.link = { tag: btn.tagName, href: btn.getAttribute('href'), target: btn.getAttribute('target'), rel: btn.getAttribute('rel') };
    info.navigated = [];
    const record = (e) => { if (e.target.closest?.('a[href]') === btn) { info.navigated.push(btn.getAttribute('href')); e.preventDefault(); } };
    document.addEventListener('click', record, true);
    btn.click();
    document.removeEventListener('click', record, true);
    info.opened = window.__opened.slice();
    window.ltf.wm.close(w.id);
    await new Promise((r) => setTimeout(r, 300));
    return info;
  }, [id, args]);
}

/** The hand-off is a genuine new-tab link to exactly `url` (not a script-opened window). */
const isTabLink = (r, url) => r.link.tag === 'A' && r.link.href === url && r.link.target === '_blank'
  && /\bnoopener\b/.test(r.link.rel) && /\bnoreferrer\b/.test(r.link.rel)
  && r.navigated.length === 1 && r.navigated[0] === url && r.opened.length === 0;

try {
  await waitFor(`${BASE}/api/ping`);
  const { chromium } = await loadPlaywright();
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

  // ═══ A. Full edition ═══
  {
    const errors = [], requests = [];
    const { ctx, page } = await desktop(BASE, { errors, requests });

    const reg = await page.evaluate(() => Object.fromEntries(['roblox', 'cinejoy', 'netflix', 'geforcenow'].map((id) => {
      const a = window.ltf.registry.get(id);
      return [id, a && { name: a.name, target: a.target, runtime: a.runtime, category: a.category, installed: a.installed, perms: a.permissions, proxy: a.proxy ?? null }];
    })));
    check('Roblox is registered: exact destination, external runtime, Games, installed', reg.roblox?.name === 'Roblox' && reg.roblox.target === ROBLOX && reg.roblox.runtime === 'external' && reg.roblox.category === 'Games' && reg.roblox.installed, JSON.stringify(reg.roblox));
    check('CineJoy is registered: exact destination, external runtime, Entertainment, installed', reg.cinejoy?.name === 'CineJoy' && reg.cinejoy.target === CINEJOY && reg.cinejoy.runtime === 'external' && reg.cinejoy.category === 'Entertainment' && reg.cinejoy.installed, JSON.stringify(reg.cinejoy));
    check('Roblox and CineJoy get no app capabilities and no proxy mode', reg.roblox.perms.length === 0 && reg.cinejoy.perms.length === 0 && reg.roblox.proxy === null && reg.cinejoy.proxy === null);
    check('Netflix opens Netflix itself (not another site under its brand)', reg.netflix.target === 'https://www.netflix.com/' && reg.netflix.runtime === 'external', JSON.stringify(reg.netflix));
    check('GeForce NOW remains its own app', reg.geforcenow?.name === 'GeForce NOW' && reg.geforcenow.target === 'https://play.geforcenow.com/', JSON.stringify(reg.geforcenow));

    // Launcher lists them with the "opens in browser" badge.
    await page.click('#start-btn');
    await page.waitForTimeout(400);
    const launcher = await page.evaluate(() => [...document.querySelectorAll('#start-menu .sm-app')].map((b) => ({ name: b.textContent.trim(), ext: !!b.querySelector('.app-icon-ext') })));
    const inLauncher = (n) => launcher.find((l) => l.name === n);
    check('launcher shows Roblox and CineJoy, badged as opening in the browser', inLauncher('Roblox')?.ext && inLauncher('CineJoy')?.ext, JSON.stringify(launcher));
    await page.keyboard.press('Escape');

    for (const [id, url] of [['roblox', ROBLOX], ['cinejoy', CINEJOY], ['netflix', NETFLIX]]) {
      const before = requests.length;
      const r = await launchExternal(page, id);
      check(`${id}: launch is a real link to exactly ${url} in a new browser tab (noopener noreferrer)`, isTabLink(r, url), JSON.stringify(r));
      check(`${id}: no iframe; the window says it opens in the browser`, !r.iframe && /opens in a normal browser tab/.test(r.text), r.text.slice(0, 120));
      const leaked = requests.slice(before).filter((u) => /\/proxy\/|\/net\/|\/api\/web\/inspect|nowgg|cinejoy|netflix\.com/.test(u));
      check(`${id}: no proxy, inspect or direct request is made by Orion`, leaked.length === 0, leaked.join(' '));
      const injected = await launchExternal(page, id, { url: 'https://evil.example/', runtime: 'direct', proxy: 'isolated' });
      check(`${id}: launch arguments cannot change the destination or runtime`, isTabLink(injected, url) && !injected.iframe && !injected.text.includes('evil'), JSON.stringify(injected));
    }
    // A user-made local app can't take over a built-in id.
    const shadow = await page.evaluate(async () => {
      try { await window.ltf.registry.createLocal?.({ name: 'Roblox', target: 'https://evil.example/', runtime: 'external' }); } catch { /* validation may reject */ }
      return window.ltf.registry.get('roblox').target;
    });
    check('a local app named "Roblox" cannot replace the built-in destination', shadow === ROBLOX, shadow);

    // ── Vapor hub ──
    await page.evaluate(() => window.ltf.wm.open('vapor'));
    await page.waitForSelector('.vp-home');
    const home = await page.evaluate(() => [...document.querySelectorAll('.vp-mode h2')].map((e) => e.textContent));
    check('Vapor opens on "Choose how you want to play" with Local and Cloud Gaming', JSON.stringify(home) === '["Local Gaming","Cloud Gaming"]', JSON.stringify(home));
    await page.click('.vp-mode-local');
    await page.click('.vp-side button:has-text("Available")');
    const available = await page.evaluate(() => [...document.querySelectorAll('.vp-card b')].map((b) => b.textContent));
    check('Local Gaming → Available lists the real catalogue', JSON.stringify(available) === '["Blocks","Snake","Pong"]', JSON.stringify(available));
    await page.click('.vp-card:has-text("Snake") .vp-fav');
    const fav = await page.evaluate(() => ({ stored: JSON.parse(localStorage.getItem('ltf:vapor:favorites')), pressed: document.querySelector('.vp-card:nth-child(2) .vp-fav')?.getAttribute('aria-pressed') }));
    check('favorites toggle and persist in vapor:favorites', JSON.stringify(fav.stored) === '["snake"]' && fav.pressed === 'true', JSON.stringify(fav));
    await page.click('.vp-side button:has-text("Favorites")');
    check('Favorites shows the favourite', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.vp-card b')].map((b) => b.textContent))) === '["Snake"]');
    await page.click('.vp-side button:has-text("Recently Played")');
    check('Recently Played is honestly empty before playing', await page.evaluate(() => document.querySelectorAll('.vp-card').length === 0 && /Nothing played yet/.test(document.querySelector('.vp-content').textContent)));
    await page.click('.vp-side button:has-text("Available")');
    await page.click('.vp-card:has-text("Blocks")');
    await page.click('.vp-btn.add');
    await page.click('.vp-btn.play');
    await page.waitForSelector('.window[data-app="webplayer"] iframe', { timeout: 8000 });
    const game = await page.evaluate(() => ({ src: document.querySelector('.window[data-app="webplayer"] iframe').getAttribute('src'), stats: JSON.parse(localStorage.getItem('ltf:vapor:stats')), lib: JSON.parse(localStorage.getItem('ltf:vapor:library')) }));
    check('a local game launches in its own Orion window and updates library/stats', game.src === 'games/blocks.html' && game.lib.includes('blocks') && game.stats.blocks?.last > 0, JSON.stringify(game));
    await page.evaluate(() => window.ltf.wm.closeApp('webplayer'));
    await page.evaluate(() => { const w = window.ltf.wm.byApp('vapor')[0]; window.ltf.wm.focus(w.id); });
    await page.click('.vp-back'); // from the game page back to Local Gaming
    await page.click('.vp-side button:has-text("Recently Played")');
    check('Recently Played now shows the game that was actually played', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.vp-card b')].map((b) => b.textContent))) === '["Blocks"]');
    await page.click('.vp-side button:has-text("Categories")');
    await page.click('.vp-filter button:has-text("Sports")');
    check('Categories filter by the catalogue’s real genres', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.vp-card b')].map((b) => b.textContent))) === '["Pong"]');
    await page.click('.vp-top nav button:has-text("Cloud Gaming")');
    const cloud = await page.evaluate(() => [...document.querySelectorAll('.vp-cloud-card h3')].map((e) => e.textContent));
    check('Cloud Gaming lists Roblox (and not GeForce NOW, which stays separate)', JSON.stringify(cloud) === '["Roblox"]', JSON.stringify(cloud));
    await page.click('.vp-cloud-card .vp-btn');
    await page.waitForSelector('.window[data-app="roblox"]', { timeout: 5000 });
    check('Cloud Gaming → Launch opens the Roblox app (its browser hand-off)', await page.evaluate(() => /opens in a normal browser tab/.test(document.querySelector('.window[data-app="roblox"] .frame-notice')?.textContent || '')));

    const real = errors.filter((e) => !/net::ERR|Failed to load resource/.test(e));
    check('full edition: no console errors', real.length === 0, real.join(' | '));
    await ctx.close();
  }

  // ═══ B. Static edition (GitHub Pages build, no server) ═══
  {
    const errors = [], requests = [];
    const statuses = [];
    const ctx0 = await browser.newContext();
    await ctx0.close();
    const { ctx, page } = await (async () => {
      const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
      await ctx.addInitScript(STUB_OPEN);
      await ctx.addInitScript(() => new MutationObserver(() => { const s = document.getElementById('boot-status')?.textContent; if (s && window.__statuses?.at(-1) !== s) (window.__statuses ??= []).push(s); }).observe(document, { subtree: true, childList: true, characterData: true }));
      const page = await ctx.newPage();
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
      page.on('request', (r) => requests.push(r.url()));
      page.on('websocket', (ws) => requests.push(ws.url()));
      await page.goto(STATIC);
      await page.waitForFunction(() => performance.getEntriesByName('orion-boot-end').length > 0, null, { timeout: 30000 });
      return { ctx, page };
    })();
    statuses.push(...await page.evaluate(() => window.__statuses || []));
    check('static: splash says honestly that the server is unavailable', statuses.some((s) => /Static edition — Orion server unavailable/.test(s)), JSON.stringify(statuses));
    const welcome = await page.waitForSelector('#entry-screen[data-mode="welcome"]', { timeout: 5000 }).catch(() => null);
    check('static: first visit still shows the welcome', !!welcome);
    await page.keyboard.press('Enter');
    await page.waitForSelector('#entry-screen', { state: 'detached', timeout: 5000 });
    const d = await page.evaluate(() => ({
      icons: document.querySelectorAll('.desk-icon').length,
      dock: document.querySelectorAll('.tb-item').length,
      sysmon: document.querySelector('.sysmon-status')?.textContent,
      netmon: document.querySelector('.netmon-label')?.textContent,
      sw: navigator.serviceWorker?.controller ? 'controlled' : 'none',
    }));
    check('static: desktop loads with apps and dock', d.icons > 0 && d.dock > 0, JSON.stringify(d));
    check('static: System Monitor and Network say "Server unavailable" (no invented data)', d.sysmon === 'Server unavailable' && d.netmon === 'Server unavailable', JSON.stringify(d));
    const serverCalls = requests.filter((u) => /\/api\/|\/ws$|\/net\/|\/proxy\//.test(new URL(u).pathname));
    check('static: never calls /api, /ws, /net or /proxy', serverCalls.length === 0, serverCalls.join(' '));

    // Local settings persist in this browser across a reload.
    await page.evaluate(() => window.ltf.store.set('theme.mode', 'light'));
    await page.reload();
    await page.waitForFunction(() => performance.getEntriesByName('orion-boot-end').length > 0, null, { timeout: 30000 });
    check('static: local settings persist across reload (light theme kept)', await page.evaluate(() => document.documentElement.dataset.theme === 'light'));
    await page.evaluate(() => window.ltf.store.set('theme.mode', 'dark'));

    // Local apps launch.
    const localApps = await page.evaluate(async () => {
      const out = {};
      for (const id of ['notepad', 'settings', 'appstore', 'spiceify']) {
        const w = await window.ltf.wm.open(id);
        await new Promise((r) => setTimeout(r, 400));
        const el = document.querySelector(`.window[data-app="${id}"]`);
        out[id] = !!el && !el.textContent.includes('App crashed');
        if (w) window.ltf.wm.close(w.id);
      }
      return out;
    });
    check('static: local apps launch (Notepad, Settings, App Store, Spiceify)', Object.values(localApps).every(Boolean), JSON.stringify(localApps));

    // Vapor's catalogue comes from the published content/games.json.
    await page.evaluate(() => window.ltf.wm.open('vapor'));
    await page.waitForSelector('.vp-home');
    await page.click('.vp-mode-local');
    await page.click('.vp-side button:has-text("Available")');
    const staticGames = await page.evaluate(() => [...document.querySelectorAll('.vp-card b')].map((b) => b.textContent));
    check('static: Vapor local catalogue works', staticGames.length === 3, JSON.stringify(staticGames));
    await page.click('.vp-card:has-text("Pong")');
    await page.click('.vp-btn.add');
    await page.click('.vp-btn.play');
    const played = await page.waitForSelector('.window[data-app="webplayer"] iframe', { timeout: 8000 }).then((e) => e.getAttribute('src')).catch(() => null);
    check('static: a local game launches in an Orion window', played === 'games/pong.html', String(played));
    await page.evaluate(() => { window.ltf.wm.closeApp('webplayer'); window.ltf.wm.closeApp('vapor'); });

    // External apps hand off to the browser exactly as in the full edition.
    for (const [id, url] of [['roblox', ROBLOX], ['cinejoy', CINEJOY], ['netflix', NETFLIX]]) {
      const r = await launchExternal(page, id);
      check(`static: ${id} opens ${url} in the browser via a real link`, isTabLink(r, url), JSON.stringify(r));
      const injected = await launchExternal(page, id, { url: 'https://evil.example/', runtime: 'direct', proxy: 'isolated' });
      check(`static: ${id} launch arguments cannot change the destination`, isTabLink(injected, url) && !injected.iframe, JSON.stringify(injected));
    }
    // A real click opens a genuine new tab at the exact destination. The test
    // answers those hosts itself so no request leaves the machine.
    await ctx.route(/^https:\/\/(172\.ip\.nowgg\.fun|cinejoy\.pk|www\.netflix\.com)\//, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>stub</title>' }));
    for (const [id, url] of [['roblox', ROBLOX], ['cinejoy', CINEJOY], ['netflix', NETFLIX]]) {
      const wid = await page.evaluate(async (appId) => (await window.ltf.wm.open(appId)).id, id);
      await page.waitForTimeout(300);
      const [tab] = await Promise.all([ctx.waitForEvent('page'), page.click(`.window[data-id="${wid}"] .frame-actions a.btn.primary`)]);
      await tab.waitForLoadState('domcontentloaded').catch(() => {});
      const opener = await tab.evaluate(() => window.opener === null).catch(() => null);
      check(`static: clicking ${id} opens a new tab at exactly ${url} without an opener`, tab.url() === url && opener === true, `${tab.url()} opener-null=${opener}`);
      await tab.close();
      await page.evaluate((w) => window.ltf.wm.close(w), wid);
    }
    await ctx.unroute(/^https:\/\/(172\.ip\.nowgg\.fun|cinejoy\.pk|www\.netflix\.com)\//);
    // A "direct" web app can't be preflighted without a server → honest browser hand-off.
    const yt = await page.evaluate(async () => {
      window.__opened = [];
      const w = await window.ltf.wm.open('youtube');
      await new Promise((r) => setTimeout(r, 500));
      const el = document.querySelector(`.window[data-id="${w.id}"]`);
      const notice = el.querySelector('.frame-notice');
      const info = { code: notice?.dataset.code, iframe: !!el.querySelector('iframe[src^="http"]'), primary: notice?.querySelector('.btn.primary')?.textContent.trim() };
      notice?.querySelector('.btn.primary')?.click();
      info.opened = window.__opened.slice();
      window.ltf.wm.close(w.id);
      return info;
    });
    check('static: a site that can’t be checked offers "Open in browser tab" (no blind iframe)', yt.code === 'SERVER_UNAVAILABLE' && !yt.iframe && yt.primary === 'Open in browser tab' && yt.opened[0]?.[0] === 'https://www.youtube.com/', JSON.stringify(yt));

    // Local lock works in the static edition too.
    await page.evaluate(() => window.ltf.wm.open('notepad'));
    await page.waitForSelector('.window[data-app="notepad"]');
    await page.keyboard.press('Control+Alt+KeyL');
    await page.waitForSelector('#entry-screen[data-mode="lock"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#entry-screen', { state: 'detached', timeout: 3000 });
    check('static: lock/unlock keeps the open window', await page.evaluate(() => !!document.querySelector('.window[data-app="notepad"]')));

    const serverCalls2 = requests.filter((u) => /\/api\/|\/ws$|\/net\/|\/proxy\//.test(new URL(u).pathname));
    check('static: still no server calls after using apps', serverCalls2.length === 0, serverCalls2.join(' '));
    const real = errors.filter((e) => !/Failed to load resource/.test(e));
    check('static: no console errors', real.length === 0, real.join(' | '));
    await ctx.close();
  }
} catch (err) {
  fail++;
  console.log('FAIL — harness error ::', err.stack || err);
} finally {
  await cleanup();
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
