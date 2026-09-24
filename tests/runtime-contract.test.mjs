// Runtime contract tests — the Step-14 runtime seam.
//
//   node --test tests/*.test.mjs
//
// No dependencies and no browser: runtimes.js, apps/webapp.js and
// core/registry.js load in plain Node, so these exercise the REAL definitions,
// handler table, dispatch and local-app validator rather than a copy of them.
// Observable in-window behavior (frames, /proxy/page, API isolation, window
// lifecycle) is covered by tests/browser/runtime.browser.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { RUNTIME_DEFS, RUNTIMES, DEFAULT_RUNTIME, normalizeRuntime } from '../static/js/core/runtimes.js';
import { RUNTIME_HANDLERS, resolveRuntime, missingRuntimeHandlers } from '../static/js/apps/webapp.js';
import { validateWebAppFields } from '../static/js/core/registry.js';

const readJson = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));

// Values a manifest, stored localStorage entry or launch arg could carry.
const HOSTILE = [
  null, undefined, 42, 0, true, '', ' ', 'Direct', 'DIRECT', ' direct', 'direct ', 'not-a-runtime',
  'constructor', '__proto__', 'prototype', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf',
  ['direct'], { id: 'direct' }, () => 'direct', Symbol('direct'),
];

// ── 1. Runtime definitions ──────────────────────────────────────────────────
test('definitions: valid ids, labels, unique, default is "direct"', () => {
  assert.ok(RUNTIME_DEFS.length > 0);
  for (const def of RUNTIME_DEFS) {
    assert.match(def.id, /^[a-z][a-z0-9-]*$/, `bad runtime id ${def.id}`);
    assert.equal(typeof def.label, 'string');
    assert.ok(def.label.trim().length > 0, `${def.id} has no App Store label`);
  }
  assert.equal(new Set(RUNTIMES).size, RUNTIMES.length, 'duplicate runtime id');
  assert.deepEqual([...RUNTIMES], RUNTIME_DEFS.map((d) => d.id), 'RUNTIMES must be derived from RUNTIME_DEFS');
  assert.equal(DEFAULT_RUNTIME, 'direct');
  assert.ok(RUNTIMES.includes(DEFAULT_RUNTIME));
});

test('definitions: the currently supported set is direct, embed, external', () => {
  // Update deliberately when a runtime is added; a silent change fails here.
  assert.deepEqual([...RUNTIMES], ['direct', 'embed', 'external']);
});

test('definitions: frozen — cannot be extended or altered at run time', () => {
  assert.ok(Object.isFrozen(RUNTIME_DEFS) && Object.isFrozen(RUNTIMES));
  assert.ok(RUNTIME_DEFS.every(Object.isFrozen));
  assert.throws(() => RUNTIMES.push('evil'), TypeError);
  assert.throws(() => RUNTIME_DEFS.push({ id: 'evil', label: 'x' }), TypeError);
  assert.throws(() => { RUNTIME_DEFS[0].id = 'evil'; }, TypeError);
  assert.equal(normalizeRuntime('evil'), 'direct');
});

test('normalizeRuntime: known ids pass through unchanged', () => {
  for (const id of RUNTIMES) assert.equal(normalizeRuntime(id), id);
});

test('normalizeRuntime: unknown / hostile values → "direct"', () => {
  for (const v of HOSTILE) assert.equal(normalizeRuntime(v), 'direct', `value ${String(v)}`);
});

// ── 2. Handler coverage ─────────────────────────────────────────────────────
test('coverage: every defined runtime has exactly one own handler', () => {
  assert.deepEqual(missingRuntimeHandlers(), []);
  for (const id of RUNTIMES) {
    assert.ok(Object.hasOwn(RUNTIME_HANDLERS, id), `no handler for ${id}`);
    assert.equal(typeof RUNTIME_HANDLERS[id].mount, 'function', `${id}.mount`);
  }
});

test('coverage: no handler exists for an undefined runtime (no second source of truth)', () => {
  assert.deepEqual(Object.keys(RUNTIME_HANDLERS).sort(), [...RUNTIMES].sort());
});

test('coverage: handler table is frozen', () => {
  assert.ok(Object.isFrozen(RUNTIME_HANDLERS));
  assert.throws(() => { RUNTIME_HANDLERS.evil = { mount() {} }; }, TypeError);
  assert.throws(() => { RUNTIME_HANDLERS.direct = RUNTIME_HANDLERS.external; }, TypeError);
});

test('coverage: missingRuntimeHandlers reports a table with gaps', () => {
  const onlyDirect = { direct: RUNTIME_HANDLERS.direct };
  assert.deepEqual(missingRuntimeHandlers(onlyDirect), RUNTIMES.filter((id) => id !== 'direct'));
  assert.deepEqual(missingRuntimeHandlers({}), [...RUNTIMES]);
});

// ── 3. Dispatch (real resolveRuntime + real table) ──────────────────────────
test('dispatch: each runtime resolves to its own entry in the real table', () => {
  for (const id of RUNTIMES) {
    const r = resolveRuntime(id);
    assert.equal(r.id, id);
    assert.equal(r.handler, RUNTIME_HANDLERS[id]);
  }
});

test('dispatch: direct and embed share the frame path; external is the hand-off', () => {
  const direct = resolveRuntime('direct').handler;
  const embed = resolveRuntime('embed').handler;
  const external = resolveRuntime('external').handler;
  assert.equal(direct.mount, embed.mount, 'embed must use the same frame mount as direct');
  assert.notEqual(external.mount, direct.mount, 'external must not use the frame path');
  assert.equal(direct.mount.name, 'mountFrame');
  assert.equal(external.mount.name, 'mountExternal');
});

test('dispatch: unknown / hostile requests resolve to the default handler', () => {
  for (const v of HOSTILE) {
    const r = resolveRuntime(v);
    assert.equal(r.id, 'direct', `value ${String(v)}`);
    assert.equal(r.handler, RUNTIME_HANDLERS.direct, `value ${String(v)}`);
  }
});

test('dispatch: defined runtime without a handler fails closed (no fallback)', () => {
  const partial = { direct: RUNTIME_HANDLERS.direct };
  for (const id of ['embed', 'external']) {
    const r = resolveRuntime(id, partial);
    assert.equal(r.id, id);
    assert.equal(r.handler, null, `${id} must not fall back to direct`);
  }
});

test('dispatch: inherited properties never act as handlers', () => {
  const evil = { mount() { throw new Error('inherited handler used'); } };
  const proto = { external: evil, constructor: evil, toString: evil, __proto__: null };
  const table = Object.create(proto);
  table.direct = RUNTIME_HANDLERS.direct;
  assert.equal(resolveRuntime('external', table).handler, null);
  assert.equal(resolveRuntime('constructor', table).handler, RUNTIME_HANDLERS.direct);
  assert.equal(resolveRuntime('toString', table).handler, RUNTIME_HANDLERS.direct);
});

// ── 5. Local apps use the same validation ───────────────────────────────────
const base = { name: 'Test', target: 'https://example.test/' };

test('local apps: every supported runtime is accepted and preserved', () => {
  for (const id of RUNTIMES) assert.equal(validateWebAppFields({ ...base, runtime: id }).runtime, id);
});

test('local apps: missing runtime defaults to "direct"', () => {
  assert.equal(validateWebAppFields(base).runtime, 'direct');
});

test('local apps: malformed runtime values are sanitized to "direct"', () => {
  for (const v of HOSTILE) assert.equal(validateWebAppFields({ ...base, runtime: v }).runtime, 'direct', `value ${String(v)}`);
});

test('local apps: validated runtime always dispatches to a real handler', () => {
  for (const v of [...HOSTILE, ...RUNTIMES]) {
    const { runtime } = validateWebAppFields({ ...base, runtime: v });
    assert.ok(resolveRuntime(runtime).handler, `value ${String(v)}`);
  }
});

test('local apps: runtime does not alter permissions (orthogonal)', () => {
  for (const id of RUNTIMES) {
    assert.deepEqual(validateWebAppFields({ ...base, runtime: id }).permissions, []);
    assert.deepEqual(validateWebAppFields({ ...base, runtime: id, permissions: ['storage'] }).permissions, ['storage']);
  }
});

// ── Built-in and catalog manifests only use defined runtimes ───────────────
test('manifests: apps.json and catalog.json runtimes are all defined', () => {
  const apps = readJson('../static/apps.json');
  const catalog = readJson('../static/catalog.json').apps;
  for (const a of [...apps, ...catalog]) {
    if ('runtime' in a) assert.ok(RUNTIMES.includes(a.runtime), `${a.id}: runtime ${a.runtime}`);
  }
});
