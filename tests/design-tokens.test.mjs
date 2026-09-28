// Design-token contract (Phase 1 visual foundation).
//
//   node --test tests/*.test.mjs
//
// CSS silently ignores an undefined custom property, so a typo in a token name
// renders as "no value" and no functional test notices. This checks, statically:
//   • every var(--x) used without a fallback is defined somewhere (CSS, or set
//     at runtime by theme.js / app code);
//   • the token tiers the shell is built on exist, in dark and light themes;
//   • transparency-off and reduced-transparency collapse the blur tokens.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const walk = (dir, ext) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p, ext) : p.endsWith(ext) ? [p] : [];
});
const cssFiles = walk(path.join(REPO, 'static/css'), '.css');
const jsFiles = walk(path.join(REPO, 'static/js'), '.js');
const css = Object.fromEntries(cssFiles.map((f) => [path.relative(REPO, f), fs.readFileSync(f, 'utf8')]));
const tokens = css['static/css/system/tokens.css'];

function definedProps() {
  const defined = new Set();
  for (const text of Object.values(css)) for (const [, name] of text.matchAll(/(--[\w-]+)\s*:/g)) defined.add(name);
  for (const f of jsFiles) {
    const text = fs.readFileSync(f, 'utf8');
    for (const [, name] of text.matchAll(/setProperty\(\s*['`](--[\w-]+)['`]/g)) defined.add(name);
    for (const [, name] of text.matchAll(/['"](--[\w-]+)['"]\s*:/g)) defined.add(name);
  }
  return defined;
}

/** Contents of the first `selector { … }` block (flat blocks only). */
function block(text, selector) {
  const i = text.indexOf(`${selector} {`);
  assert.ok(i >= 0, `missing block ${selector}`);
  return text.slice(i, text.indexOf('\n}', i));
}

test('every custom property used without a fallback is defined', () => {
  const defined = definedProps();
  const missing = [];
  for (const [file, text] of Object.entries(css)) {
    for (const [, name, sep] of text.matchAll(/var\((--[\w-]+)\s*([,)])/g)) {
      if (sep === ')' && !defined.has(name)) missing.push(`${name} (${file})`);
    }
  }
  assert.deepEqual([...new Set(missing)], [], 'undefined tokens render as nothing');
});

test('the shell token tiers exist', () => {
  const root = block(tokens, ':root');
  for (const name of [
    '--bg-0', '--bg-1', '--bg-2',                                        // background layers
    '--surface-1', '--surface-2', '--surface-3', '--surface-hover',      // surfaces
    '--glass-float', '--glass-window', '--blur-sm', '--blur', '--blur-lg', // glass tiers
    '--border', '--border-strong', '--border-accent',                    // borders
    '--text', '--text-2', '--text-3',                                    // text hierarchy
    '--accent-color', '--accent-color-2', '--accent-gradient',           // accent
    '--focus-outline', '--focus-ring',                                   // focus
    '--elev-1', '--elev-2', '--elev-3', '--elev-4',                      // elevation
    '--radius-sm', '--radius', '--radius-lg', '--radius-xl', '--radius-pill',
    '--space-1', '--space-2', '--space-4', '--space-8',                  // spacing
    '--fs-xs', '--fs-sm', '--fs', '--fs-md', '--fs-lg', '--fs-xl', '--fs-display',
    '--dur-fast', '--dur', '--dur-slow', '--ease', '--ease-out',          // motion
    '--z-widgets', '--z-taskbar', '--z-flyout', '--z-toast', '--z-menu', '--z-lock',
  ]) assert.match(root, new RegExp(`${name}\\s*:`), `${name} missing from :root`);
});

test('runtime-themed tokens keep their names (theme.js writes them)', () => {
  const themeJs = fs.readFileSync(path.join(REPO, 'static/js/core/theme.js'), 'utf8');
  for (const name of ['--accent-color', '--accent-color-2', '--accent-color-contrast', '--system-glass-opacity']) {
    assert.ok(themeJs.includes(`'${name}'`), `theme.js no longer sets ${name}`);
    assert.match(block(tokens, ':root'), new RegExp(`${name}\\s*:`), `${name} lost its default`);
  }
});

test('light theme overrides the text and surface hierarchy', () => {
  const light = block(tokens, ':root[data-theme="light"]');
  for (const name of ['--text', '--text-2', '--text-3', '--surface-2', '--surface-hover', '--system-glass-rgb', '--elev-3']) {
    assert.match(light, new RegExp(`${name}\\s*:`), `light theme must override ${name}`);
  }
});

test('transparency off and reduced transparency remove blur', () => {
  const off = block(tokens, ':root[data-transparency="off"]');
  const reduced = tokens.slice(tokens.indexOf('@media (prefers-reduced-transparency: reduce)'));
  for (const b of [off, reduced]) {
    for (const name of ['--system-glass-blur', '--system-glass-blur-strong', '--blur-sm']) {
      assert.match(b, new RegExp(`${name}:\\s*0px`), `${name} must collapse to 0px`);
    }
  }
});

test('reduced motion stops movement and looping animation', () => {
  const base = css['static/css/system/base.css'];
  const rm = base.slice(base.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(rm, /animation-duration:\s*1ms !important/);
  assert.match(rm, /transition-duration:\s*1ms !important/);
  assert.match(rm, /animation-iteration-count:\s*1 !important/);
});
