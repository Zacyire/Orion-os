// Static edition under a sub-path (GitHub Pages /Orion-os/) — module loading.
//
//   node tests/browser/basepath.browser.mjs
//
// Serves the static build at /Orion-os/ with a plain file server (nothing at
// the root), twice:
//   1. as-is, like GitHub Pages;
//   2. behind a simulated URL-rewriting layer that rewrites every dynamic
//      import(x) to import(rewrite(x)), where rewrite() resolves x against the
//      *page* URL — what some URL-rewriting web proxies do, since they can't
//      know the calling module's real URL. With module-relative specifiers
//      ("../apps/x.js") that produced "Failed to fetch dynamically imported
//      module: <host>/apps/webapp.js" and no app could open.
// The simulation only changes how import() specifiers are resolved; it does
// not proxy anything. In both modes: apps open, Roblox/CineJoy/Netflix are
// real links to their exact pinned destinations, and the static edition makes
// no /api, /ws, /net or /proxy request.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PREFIX = '/Orion-os/';
const LINKS = { roblox: 'https://172.ip.nowgg.fun/apps/a/19900/b.html', cinejoy: 'https://cinejoy.pk/', netflix: 'https://www.netflix.com/' };

async function loadPlaywright() {
  try { const m = await import('playwright'); return m.default ?? m; } catch { /* fall through */ }
  const root = execSync('npm root -g').toString().trim();
  const m = await import(pathToFileURL(path.join(root, 'playwright', 'index.js')).href);
  return m.default ?? m;
}

let passed = 0, failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++; else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n       ${detail}`}`);
}

/** Wrap the argument of every `import(` call (balanced parentheses) in __rewrite(). */
function rewriteImports(src) {
  let out = '', i = 0, count = 0;
  for (;;) {
    const at = src.indexOf('import(', i);
    if (at < 0) return { src: out + src.slice(i), count };
    let depth = 1, j = at + 'import('.length;
    for (; j < src.length && depth; j++) { if (src[j] === '(') depth++; else if (src[j] === ')') depth--; }
    out += `${src.slice(i, at)}import(__rewrite(${src.slice(at + 'import('.length, j - 1)}))`;
    i = j; count++;
  }
}

const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-basepath-'));
execFileSync(path.join(REPO, 'tools/build-static.sh'), [siteDir], { cwd: REPO, stdio: 'ignore' });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
let rewriteMode = false, rewritten = 0;
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const rel = p.startsWith(PREFIX) ? p.slice(PREFIX.length) || 'index.html' : null;
  const file = rel && path.join(siteDir, path.normalize(rel));
  if (!file || !file.startsWith(siteDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('404'); }
  const ext = path.extname(file);
  let body = fs.readFileSync(file);
  if (rewriteMode && ext === '.js') { const r = rewriteImports(body.toString()); rewritten += r.count; body = r.src; }
  if (rewriteMode && ext === '.html') body = body.toString().replace('<head>', '<head><script>window.__rewrite = (s) => new URL(s, document.baseURI).href;</script>');
  res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream' });
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}${PREFIX}`;

let browser;
try {
  const { chromium } = await loadPlaywright();
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  for (const mode of ['plain', 'rewrite']) {
    rewriteMode = mode === 'rewrite';
    const label = rewriteMode ? 'rewritten import()' : `served at ${PREFIX}`;
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    await ctx.addInitScript(() => localStorage.setItem('ltf:entry', JSON.stringify({ seen: 1 })));
    const page = await ctx.newPage();
    const errors = [], requests = [], notFound = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('request', (r) => requests.push(r.url()));
    page.on('websocket', (ws) => requests.push(ws.url()));
    page.on('response', (r) => { if (r.status() === 404) notFound.push(r.url()); });
    await page.goto(BASE);
    const booted = await page.waitForFunction(() => performance.getEntriesByName('orion-boot-end').length > 0, null, { timeout: 30000 }).then(() => true, () => false);
    check(`${label}: boots to the desktop`, booted);

    const opened = await page.evaluate(async (ids) => {
      const out = {};
      for (const id of ids) {
        try {
          const w = await window.ltf.wm.open(id);
          await new Promise((r) => setTimeout(r, 300));
          const el = document.querySelector(`.window[data-id="${w.id}"]`);
          const a = el?.querySelector('.frame-actions a.btn.primary');
          out[id] = { content: !!el?.querySelector('.app, .frame-notice'), link: a && { href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel') } };
          window.ltf.wm.close(w.id);
        } catch (e) { out[id] = { error: e.message }; }
      }
      return out;
    }, ['notepad', 'vapor', ...Object.keys(LINKS)]);
    check(`${label}: local apps open (Notepad, Vapor)`, opened.notepad?.content && opened.vapor?.content, JSON.stringify(opened));
    for (const [id, url] of Object.entries(LINKS)) {
      const l = opened[id]?.link;
      check(`${label}: ${id} opens as a real link to exactly ${url}`, l?.href === url && l.target === '_blank' && /noopener/.test(l.rel) && /noreferrer/.test(l.rel), JSON.stringify(opened[id]));
    }
    check(`${label}: no module or resource 404s`, notFound.length === 0, notFound.join(' '));
    const calls = requests.filter((u) => /\/(api|net|proxy)\/|\/ws(\?|$)/.test(new URL(u).pathname + new URL(u).search) || u.startsWith('ws'));
    check(`${label}: never calls /api, /ws, /net or /proxy`, calls.length === 0, calls.join(' '));
    check(`${label}: no console errors`, errors.length === 0, errors.join(' | '));
    if (rewriteMode) check('the rewrite simulation actually rewrote import() calls', rewritten >= 1, String(rewritten));
    await ctx.close();
  }
} catch (err) {
  failed++;
  console.error(err);
} finally {
  await browser?.close();
  server.close();
  fs.rmSync(siteDir, { recursive: true, force: true });
}
console.log(`\n===== ${passed} passed, ${failed} failed =====`);
process.exit(failed ? 1 : 0);
