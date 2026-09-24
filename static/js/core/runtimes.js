// Web-app runtimes — the single authoritative list.
//
// A runtime decides how a web-app's `target` is delivered into its window.
// This module is DATA ONLY (no DOM, no frame code) so the registry, the App
// Store and the web-app container can all import it without pulling in UI:
//
//   registry.js   → validates/sanitizes local-app manifests (normalizeRuntime)
//   appstore.js   → renders the New/Edit web app "Runtime" choices (RUNTIME_DEFS)
//   apps/webapp.js→ dispatches to the handler registered for the id
//
// Adding a runtime = one entry here + one handler in apps/webapp.js.
//
// `runtime` is orthogonal to `proxy` ("off" | "isolated"): isolation is a
// transport modifier applied by core/frame.js, not a runtime. It is also
// orthogonal to permissions — a runtime only renders, it never grants a
// capability (see core/appbridge.js).

export const DEFAULT_RUNTIME = 'direct';

export const RUNTIME_DEFS = [
  { id: 'direct', label: 'Direct — show the site in the app window' },
  { id: 'embed', label: 'Embed — target is a provider embed URL' },
  { id: 'external', label: 'External — open the site in Orion' },
];

/** Known runtime ids, in display order. */
export const RUNTIMES = RUNTIME_DEFS.map((r) => r.id);

/**
 * A known runtime id, or DEFAULT_RUNTIME for anything else (missing, unknown,
 * non-string). Arbitrary strings never survive, so a manifest or launch arg
 * can't select a handler that isn't in this list.
 */
export function normalizeRuntime(value) {
  return typeof value === 'string' && RUNTIMES.includes(value) ? value : DEFAULT_RUNTIME;
}
