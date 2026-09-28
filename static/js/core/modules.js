// Trusted shell modules — the ONLY scripts the shell will import dynamically.
//
// The shell imports app code by name in three places:
//   registry.loadModule   → js/apps/<module>.js         (kind "app")
//   webapp.js fallback    → js/apps/<fallback>.js       (kind "fallback")
//   webapp.js panel       → js/apps/panels/<panel>.js   (kind "panel")
// A name coming from app data (a manifest, localStorage, a future Vapor
// package) must never be able to choose which same-origin script runs in the
// shell. So the set is fixed here, by Orion OS itself; anything else — unknown
// names, paths, URLs, `javascript:`/`data:`, encoded traversal, inherited
// property names, non-strings — fails closed. Adding a shell module means
// adding its name here (tests/runtime-contract.test.mjs checks every name has
// a file and every built-in resolves to a listed name).

export const TRUSTED_MODULES = Object.freeze({
  app: Object.freeze(['appstore', 'notepad', 'orion', 'settings', 'spiceify', 'vapor', 'webapp']),
  fallback: Object.freeze(['youtube']),
  panel: Object.freeze(['geforcenow']),
});

// Bare module names only: no dots, slashes, colons, percent-encoding or case tricks.
const NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** `name` if it is a trusted module of `kind`, else throws. */
export function trustedModule(kind, name) {
  const list = Object.hasOwn(TRUSTED_MODULES, kind) ? TRUSTED_MODULES[kind] : null;
  if (!list || typeof name !== 'string' || !NAME.test(name) || !list.includes(name)) {
    throw new Error(`untrusted ${typeof kind === 'string' ? kind : '?'} module refused`);
  }
  return name;
}

export function isTrustedModule(kind, name) {
  try { trustedModule(kind, name); return true; } catch { return false; }
}
