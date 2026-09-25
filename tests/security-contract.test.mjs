// Security contract tests — trusted shell modules and local-app sanitizing.
//
//   node --test tests/*.test.mjs
//
// Exercises the REAL modules.js allowlist and registry.localManifest (both load
// in plain Node). End-to-end behaviour (registry.load, loadModule, launches) is
// covered by tests/browser/security.browser.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { TRUSTED_MODULES, trustedModule, isTrustedModule } from '../static/js/core/modules.js';
import { localManifest, validateWebAppFields } from '../static/js/core/registry.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const exists = (p) => fs.existsSync(new URL(p, import.meta.url));

// ── the trusted set ─────────────────────────────────────────────────────────
test('modules: trusted set is frozen and every name has a file', () => {
  assert.ok(Object.isFrozen(TRUSTED_MODULES));
  for (const kind of Object.keys(TRUSTED_MODULES)) assert.ok(Object.isFrozen(TRUSTED_MODULES[kind]), kind);
  assert.throws(() => TRUSTED_MODULES.app.push('evil'), TypeError);
  for (const n of TRUSTED_MODULES.app) assert.ok(exists(`../static/js/apps/${n}.js`), `app module ${n}`);
  for (const n of TRUSTED_MODULES.fallback) assert.ok(exists(`../static/js/apps/${n}.js`), `fallback ${n}`);
  for (const n of TRUSTED_MODULES.panel) assert.ok(exists(`../static/js/apps/panels/${n}.js`), `panel ${n}`);
});

test('modules: every built-in app resolves to a trusted module (no legit app broken)', () => {
  const apps = JSON.parse(read('../static/apps.json'));
  for (const a of apps) {
    const type = a.type || 'native';
    const mod = type === 'web-app' ? 'webapp' : type === 'browser' ? 'orion' : (a.module || a.id);
    assert.ok(isTrustedModule('app', mod), `${a.id} → ${mod}`);
    if ('fallback' in a) assert.ok(isTrustedModule('fallback', a.fallback), `${a.id} fallback ${a.fallback}`);
    if ('panel' in a) assert.ok(isTrustedModule('panel', a.panel), `${a.id} panel ${a.panel}`);
  }
  // Server-generated custom apps (src/handlers/apps.rs) use the web container.
  assert.match(read('../src/handlers/apps.rs'), /"module": "webapp"/);
  assert.ok(isTrustedModule('app', 'webapp'));
});

test('modules: every listed name is accepted for its own kind only', () => {
  for (const [kind, names] of Object.entries(TRUSTED_MODULES)) {
    for (const n of names) assert.equal(trustedModule(kind, n), n);
  }
  assert.equal(isTrustedModule('app', 'youtube'), false, 'fallback-only module is not an app module');
  assert.equal(isTrustedModule('app', 'geforcenow'), false, 'panel is not an app module');
  assert.equal(isTrustedModule('panel', 'webapp'), false);
});

test('modules: untrusted values fail closed', () => {
  const hostile = [
    'evil', 'unknown', 'WEBAPP', 'webapp.js', 'webapp/', ' webapp', 'webapp ',
    '../../static/js/something-dangerous', '../../static/js/something-dangerous.js', '../apps/webapp', './webapp',
    '/js/apps/webapp', '..%2F..%2Fjs%2Fcore%2Fstore', '%2e%2e/x', '..\\x', 'panels/geforcenow',
    'https://evil.example/x', '//evil.example/x', 'javascript:alert(1)', 'data:text/javascript,alert(1)', 'blob:x',
    'constructor', '__proto__', 'prototype', 'toString', 'hasOwnProperty', 'valueOf',
    '', null, undefined, 42, true, ['webapp'], { toString: () => 'webapp' }, Symbol('webapp'),
  ];
  for (const v of hostile) {
    assert.throws(() => trustedModule('app', v), /untrusted/, `app ${String(v)}`);
    assert.equal(isTrustedModule('fallback', v), false);
    assert.equal(isTrustedModule('panel', v), false);
  }
  for (const kind of ['constructor', '__proto__', 'toString', 'nope', null]) {
    assert.equal(isTrustedModule(kind, 'webapp'), false, `kind ${String(kind)}`);
  }
});

// ── local apps never carry module/fallback/panel/frame options ──────────────
const fields = () => validateWebAppFields({ name: 'X', target: 'https://example.test/', runtime: 'direct' });

test('local apps: stored module/fallback/panel/frame fields are dropped', () => {
  const stored = {
    module: '../../static/js/something-dangerous', fallback: '../../evil', panel: '../x', type: 'native',
    sandbox: null, allow: 'camera; microphone', proxy: 'javascript:alert(1)', controls: ['panel'], system: true, hidden: true,
    catalogId: 'cat.x', description: 'desc', version: '2.0.0', icon: 'globe',
  };
  const m = localManifest('web-x', fields(), stored);
  for (const k of ['module', 'fallback', 'panel', 'sandbox', 'allow', 'proxy', 'controls', 'system', 'hidden']) {
    assert.ok(!Object.hasOwn(m, k), `${k} must not survive`);
  }
  assert.equal(m.type, 'web-app');
  assert.equal(m.local, true);
  assert.deepEqual([m.catalogId, m.description, m.version, m.icon], ['cat.x', 'desc', '2.0.0', 'globe']);
});

test('local apps: frame options survive only in their safe, typed form', () => {
  // Isolated mode (opaque /proxy/page sandbox) and suspend-on-minimize only
  // reduce privilege/resource use; anything else is dropped.
  assert.equal(localManifest('web-x', fields(), { proxy: 'isolated' }).proxy, 'isolated');
  assert.equal(localManifest('web-x', fields(), { proxy: 'off' }).proxy, 'off');
  for (const bad of ['direct', 'ISOLATED', 'javascript:x', true, 1, {}, null]) {
    assert.ok(!Object.hasOwn(localManifest('web-x', fields(), { proxy: bad }), 'proxy'), `proxy ${String(bad)}`);
  }
  assert.equal(localManifest('web-x', fields(), { suspendOnMinimize: true }).suspendOnMinimize, true);
  for (const bad of ['true', 1, {}, false]) {
    assert.ok(!Object.hasOwn(localManifest('web-x', fields(), { suspendOnMinimize: bad }), 'suspendOnMinimize'), `suspend ${String(bad)}`);
  }
});

test('local apps: prototype-pollution-shaped input cannot inject fields', () => {
  const stored = JSON.parse('{"__proto__": {"module": "../../evil", "fallback": "x"}, "constructor": {"prototype": {"module": "y"}}}');
  const m = localManifest('web-x', fields(), stored);
  assert.ok(!Object.hasOwn(m, 'module') && !Object.hasOwn(m, 'fallback'));
  assert.equal(({}).module, undefined, 'Object.prototype untouched');
});

test('local apps: icon keeps plain glyph names only', () => {
  for (const bad of ['constructor', 'toString', '__proto__', 'hasOwnProperty', '../x', '<img>', 'Globe', '', 42]) {
    assert.ok(!Object.hasOwn(localManifest('web-x', fields(), { icon: bad }), 'icon'), `icon ${String(bad)}`);
  }
  assert.equal(localManifest('web-x', fields(), { icon: 'globe' }).icon, 'globe');
});

test('local apps: non-string or oversized display fields are dropped or capped', () => {
  const m = localManifest('web-x', fields(), { description: { toString: () => 'x' }, version: 3, catalogId: 'a'.repeat(2000) });
  assert.ok(!Object.hasOwn(m, 'description') && !Object.hasOwn(m, 'version'));
  assert.equal(m.catalogId.length, 500);
});
