// Static edition build + GitHub Pages workflow (Beta 0.1).
//
//   node --test tests/*.test.mjs
//
// Builds the static edition into a temp directory with tools/build-static.sh
// and checks what GitHub Pages would serve: the frontend and catalogues, the
// static-edition marker, the operator-configured app destinations — and
// nothing server-side or secret. Also checks the workflow's shape: least
// privilege, pinned official actions, no secrets, no deploy from PRs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-static-build-'));
const log = execFileSync(path.join(REPO, 'tools/build-static.sh'), [out], { cwd: REPO, encoding: 'utf8' });
process.on('exit', () => fs.rmSync(out, { recursive: true, force: true }));
const read = (f) => fs.readFileSync(path.join(out, f), 'utf8');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : [p];
});

test('build succeeds and reports its output', () => {
  assert.match(log, /static edition built in/);
});

test('generated static files exist', () => {
  for (const f of ['index.html', 'js/app.js', 'js/core/api.js', 'js/core/boot.js', 'js/core/entry.js', 'js/apps/vapor.js',
    'css/system/tokens.css', 'apps.json', 'catalog.json', 'content/games.json', 'content/wallpapers.json',
    'media/wallpapers/aurora-ridge.jpg', '.nojekyll']) {
    assert.ok(fs.existsSync(path.join(out, f)), `missing ${f}`);
  }
  const games = JSON.parse(read('content/games.json'));
  assert.ok(games.items.length > 0, 'Vapor local catalogue is published');
  assert.deepEqual(games.cloud.map((c) => Object.keys(c)), [['app']], 'cloud entries name apps only (no URLs)');
});

test('the page is marked as the static edition (source stays "full")', () => {
  assert.match(read('index.html'), /<meta name="orion-edition" content="static" \/>/);
  assert.doesNotMatch(read('index.html'), /content="full"/);
  assert.match(fs.readFileSync(path.join(REPO, 'static/index.html'), 'utf8'), /<meta name="orion-edition" content="full" \/>/);
});

test('only frontend files: no server, deployment, data or test directories', () => {
  for (const d of ['src', 'deploy', 'data', 'target', '.github', 'tests', 'docs', 'tools']) {
    assert.ok(!fs.existsSync(path.join(out, d)), `${d}/ must not be published`);
  }
  const files = walk(out).map((f) => path.relative(out, f));
  assert.ok(!files.some((f) => /\.(rs|toml|lock|pem|key|env|sh)$/.test(f) || /access-key/.test(f)), files.filter((f) => /\.(rs|toml|lock|pem|key|env|sh)$/.test(f)).join(', '));
});

test('no secrets in the published files', () => {
  const pattern = /BEGIN ([A-Z]+ )?PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|github_pat_|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|LTF_ACCESS_KEY=/;
  for (const f of walk(out)) {
    if (/\.(png|jpe?g|webp|webm|mp4|woff2?)$/.test(f)) continue;
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), pattern, path.relative(out, f));
  }
});

test('Roblox and CineJoy are registered with their exact operator-configured destinations', () => {
  const apps = JSON.parse(read('apps.json'));
  const byId = Object.fromEntries(apps.map((a) => [a.id, a]));
  assert.equal(byId.roblox?.target, 'https://172.ip.nowgg.fun/apps/a/19900/b.html');
  assert.equal(byId.cinejoy?.target, 'https://cinejoy.pk/');
  for (const id of ['roblox', 'cinejoy']) {
    assert.equal(byId[id].type, 'web-app');
    assert.equal(byId[id].runtime, 'external', `${id} opens in the user's browser`);
    assert.ok(!('proxy' in byId[id]), `${id} must not request any proxy mode`);
    assert.ok(!byId[id].permissions?.length, `${id} gets no window.ltf capabilities`);
  }
  // No app may present one site under another brand: Netflix opens Netflix.
  assert.equal(byId.netflix.target, 'https://www.netflix.com/');
  assert.ok(!apps.some((a) => a.id !== 'cinejoy' && /cinejoy/i.test(a.target || '')), 'cinejoy.pk only behind the CineJoy entry');
  // GeForce NOW stays its own app (not folded into Vapor).
  assert.equal(byId.geforcenow?.target, 'https://play.geforcenow.com/');
});

test('workflow: least privilege, pinned official actions, no secrets, no PR deploys', () => {
  const wf = fs.readFileSync(path.join(REPO, '.github/workflows/pages.yml'), 'utf8');
  assert.match(wf, /^permissions:\n {2}contents: read$/m, 'workflow default is read-only');
  assert.match(wf, /pages: write\n\s+id-token: write/, 'only the deploy job can write Pages');
  assert.match(wf, /if: github\.event_name != 'pull_request'/, 'PRs never deploy');
  assert.doesNotMatch(wf, /secrets\./, 'no secrets referenced');
  assert.match(wf, /run: \.\/tools\/build-static\.sh _site/);
  assert.match(wf, /path: _site/);
  const uses = [...wf.matchAll(/uses: ([\w./-]+)@(\S+)/g)].map((m) => [m[1], m[2]]);
  assert.ok(uses.length >= 4);
  for (const [action, ref] of uses) {
    assert.match(action, /^actions\//, `only official actions: ${action}`);
    assert.match(ref, /^v\d+$/, `${action} pinned to a major version`);
  }
  // Full YAML parse when a parser is available (CI runners and dev machines usually have PyYAML).
  const py = spawnSync('python3', ['-c', 'import sys,yaml; d=yaml.safe_load(open(sys.argv[1])); assert set(d["jobs"])=={"build","deploy"}; print("ok")', path.join(REPO, '.github/workflows/pages.yml')], { encoding: 'utf8' });
  if (py.status === 0 || !/No module named/.test(py.stderr || '')) assert.equal(py.stdout.trim(), 'ok', py.stderr);
});
