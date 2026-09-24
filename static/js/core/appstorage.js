// Per-app persistent storage (Step 11) — host side.
//
// Each app gets an ISOLATED namespace derived from its host-identified app id.
// The app never sees or supplies the namespace, so one app can never read or
// clear another app's data. Values are JSON-serialized into browser
// localStorage (persistent, no backend). One localStorage entry per (app, key):
//
//   ltf:appdata:<appId>:<key>
//
// This is deliberately localStorage rather than IndexedDB: the data is small
// key/value settings and the public `ltf.storage` API is already async
// (Promise-based), so the implementation can move to IndexedDB later without
// changing the app-facing API.

const PREFIX = 'ltf:appdata:';

// Per-value size cap. Not a full quota system — just a guard against obviously
// unreasonable payloads. 100 KB of serialized JSON per key.
export const MAX_VALUE_BYTES = 100 * 1024;
// Keys are short identifiers, not data. Cap them too.
export const MAX_KEY_LENGTH = 256;

const nsPrefix = (appId) => `${PREFIX}${appId}:`;
const fullKey = (appId, key) => nsPrefix(appId) + key;

/** A usable storage key: a non-empty, reasonably short string. */
export function validKey(key) {
  return typeof key === 'string' && key.length > 0 && key.length <= MAX_KEY_LENGTH;
}

/** Byte length of a UTF-8 string (for the size guard). */
function byteLength(str) {
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(str).length : unescape(encodeURIComponent(str)).length;
}

export const appStorage = {
  /** Stored value, or null when the key is missing. */
  get(appId, key) {
    const raw = localStorage.getItem(fullKey(appId, key));
    if (raw == null) return null;
    try { return JSON.parse(raw); } catch { return null; }
  },

  /**
   * Store a JSON-compatible value. Throws (host stays alive; the bridge turns
   * this into a safe rejection) when the value is not JSON-serializable or
   * exceeds the size limit. Functions/DOM nodes are already rejected earlier by
   * postMessage's structured clone; cyclic objects are caught here by JSON.
   */
  set(appId, key, value) {
    let json;
    try { json = JSON.stringify(value); } catch { throw new Error('value is not JSON-serializable'); }
    if (json === undefined) throw new Error('value is not JSON-serializable');
    const bytes = byteLength(json);
    if (bytes > MAX_VALUE_BYTES) throw new Error(`value exceeds ${MAX_VALUE_BYTES}-byte limit`);
    localStorage.setItem(fullKey(appId, key), json); // may throw QuotaExceededError → bridge rejects
  },

  remove(appId, key) {
    localStorage.removeItem(fullKey(appId, key));
  },

  /** Remove only this app's keys (its own namespace). */
  clear(appId) {
    const p = nsPrefix(appId);
    const doomed = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(p)) doomed.push(k);
    }
    doomed.forEach((k) => localStorage.removeItem(k));
  },
};
