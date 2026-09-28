// App Registry — the catalogue of apps, which are installed, and how to
// load each one. Apps are ES modules in /js/apps/<module>.js exporting:
//
//   export default {
//     single?: true,                                      // one window per app
//     mount(body, ctx) { ...; return () => cleanup(); }  // required
//   }
//   mount may also return { destroy, onFocus, onResize, onArgs, beforeClose,
//   onMinimize, onRestore }.
//
// App types: "native" (a module), "web-app" (a website as an app — only
// `target` needed, rendered by apps/webapp.js) and "browser" (Orion).
//
// The catalogue is built-in apps (from /api/apps, or static apps.json when
// offline) merged with user-created web apps stored in localStorage
// (createLocal / editLocal / removeLocal). Built-in ids always take precedence.

import { api } from './api.js';
import { bus } from './events.js';
import { local } from './dom.js';
import { normalizeRuntime } from './runtimes.js';
import { trustedModule } from './modules.js';

let catalog = [];

// Orion OS App Catalog: apps available to install, distinct from installed apps
// (localStorage) and built-in apps (apps.json). Static for now; loadCatalog is
// the single seam a remote catalog would later replace.
let catalogApps = [];
const catalogById = new Map();

const USER_APPS_KEY = 'user-apps';
/** User-created web apps, persisted in localStorage (Step 4). */
function userApps() {
  const list = local.get(USER_APPS_KEY, []);
  return Array.isArray(list) ? list : [];
}
function saveUserApps(list) {
  local.set(USER_APPS_KEY, list);
}

// App capability permissions (Step 10). Deliberately tiny: this is the seam a
// future storage/clipboard/dialog/IPC permission would slot into. A permission
// is only ever granted by the app's manifest (host-controlled); an app can
// never grant itself one from JavaScript.
export const PERMISSIONS = ['notifications', 'open-external', 'storage', 'window'];
export const PERMISSION_LABELS = {
  notifications: 'Notifications',
  'open-external': 'Open external URLs',
  storage: 'Persistent storage',
  window: 'Window control',
};

/** Normalize a manifest's permissions to a clean array of known ids (default []). */
export function normalizePermissions(list) {
  if (!Array.isArray(list)) return [];
  return PERMISSIONS.filter((p) => list.includes(p)); // known ids only, deduped, stable order
}

/**
 * Validate and normalize a web-app manifest's editable fields. Throws an Error
 * with a human message on invalid input; callers surface it in the UI.
 * `icon`/`iconUrl` are interchangeable on input (older manifests used `icon`).
 */
export function validateWebAppFields({ name, target, runtime, icon, iconUrl, permissions }) {
  name = (name || '').trim();
  if (!name) throw new Error('Name is required.');
  if (name.length > 60) throw new Error('Name is too long (60 characters max).');
  let url;
  try {
    url = new URL((target || '').trim());
  } catch {
    throw new Error('Enter a valid URL, including https://');
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Only http:// and https:// URLs are supported.');
  // Unknown/missing runtimes are sanitized to the default (core/runtimes.js).
  const out = { name, target: url.href, runtime: normalizeRuntime(runtime), permissions: normalizePermissions(permissions) };
  // Icon URL. `icon` may instead hold a glyph name (e.g. "globe") from a
  // catalog entry — that is not a URL and is left untouched, not rejected.
  const explicit = iconUrl != null ? String(iconUrl).trim() : '';
  const iconIsUrl = typeof icon === 'string' && /^https?:\/\//i.test(icon.trim());
  const raw = explicit || (iconIsUrl ? icon.trim() : '');
  if (raw) {
    if (!/^https?:\/\//i.test(raw)) throw new Error('Icon URL must start with http:// or https://');
    out.iconUrl = raw;
  }
  return out;
}

/** Build a full stored manifest for a user web app. */
function userManifest(id, fields) {
  const m = { id, name: fields.name, type: 'web-app', runtime: fields.runtime, target: fields.target, permissions: fields.permissions || [], local: true };
  if (fields.iconUrl) m.iconUrl = fields.iconUrl;
  return m;
}

// Display-only metadata a local app may carry beyond its validated core
// (catalog installs add these), plus two strictly typed frame options below.
// Nothing else from stored/app data is copied — in particular never `module`,
// `fallback`, `panel`, `sandbox`, `allow`, `controls` or `type`, which select
// shell code or widen frame privileges.
const LOCAL_EXTRA = ['catalogId', 'description', 'version'];
const GLYPH = /^[a-z][a-z0-9]{0,31}$/;

/**
 * The ONLY way a local (untrusted, localStorage-sourced) app becomes a
 * manifest: validated core fields + an allowlist of short display strings.
 * Stored data is never spread into a registry entry.
 */
export function localManifest(id, fields, extra = {}) {
  const m = userManifest(id, fields);
  for (const k of LOCAL_EXTRA) {
    if (Object.hasOwn(extra, k) && typeof extra[k] === 'string') m[k] = extra[k].slice(0, 500);
  }
  // Glyph icon names from the catalog (e.g. "globe"); never inherited names
  // like "constructor", which would resolve on the icon tables' prototypes.
  if (Object.hasOwn(extra, 'icon') && typeof extra.icon === 'string' && GLYPH.test(extra.icon) && !(extra.icon in Object.prototype)) {
    m.icon = extra.icon;
  }
  // Frame options that can only REDUCE privilege or resource use, strictly
  // typed: isolated mode renders through the opaque /proxy/page sandbox (which
  // never gets the bridge); suspendOnMinimize unloads the page while minimized.
  if (Object.hasOwn(extra, 'proxy') && (extra.proxy === 'isolated' || extra.proxy === 'off')) m.proxy = extra.proxy;
  if (Object.hasOwn(extra, 'suspendOnMinimize') && extra.suspendOnMinimize === true) m.suspendOnMinimize = true;
  return m;
}

/** Stable, collision-free, filesystem-safe id derived from the app name. */
function uniqueId(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
  let id = `web-${slug}`;
  for (let n = 2; byId.has(id) || userApps().some((a) => a.id === id); n++) id = `web-${slug}-${n}`;
  return id;
}

/**
 * Fill defaults so a minimal entry such as
 *   { "id": "example", "name": "Example", "type": "web-app", "target": "https://example.com" }
 * is a complete app. Mirrors CatalogApp in src/catalog.rs.
 */
function normalize(a) {
  const type = a.type || 'native';
  return {
    icon: 'web', category: 'Web', description: '', developer: '', version: '1.0.0', default_size: [1180, 740],
    ...a,
    type,
    // Web apps and the browser always use their fixed container module; only
    // built-in native apps name their own (and loadModule still checks it
    // against the trusted set in core/modules.js).
    module: type === 'web-app' ? 'webapp' : type === 'browser' ? 'orion' : (a.module || a.id),
    // Missing permissions == no capabilities. Sanitized to known ids so a bad
    // manifest can never smuggle in an unknown capability.
    permissions: normalizePermissions(a.permissions),
  };
}
const byId = new Map();

export const registry = {
  async load({ timeout } = {}) {
    let apps;
    try {
      apps = await api.get('/apps', { timeout });
    } catch {
      // Offline: read the static catalogue and use locally tracked installs.
      const res = await fetch('apps.json');
      const all = await res.json();
      const installed = new Set(local.get('installed', all.map((a) => a.id)));
      apps = all.map((a) => ({ ...a, installed: a.system || installed.has(a.id) }));
    }
    catalog = apps.map(normalize);
    byId.clear();
    for (const a of catalog) byId.set(a.id, a);
    // Merge user-created web apps (localStorage). Built-in ids always win, so a
    // user manifest can never shadow or alter a built-in app. Malformed
    // manifests are skipped with a warning rather than throwing.
    for (const ua of userApps()) {
      if (!ua || !ua.id || byId.has(ua.id)) continue;
      let app;
      try {
        // Validated core + allowlisted display fields only (never a spread of
        // stored data — it could otherwise name shell modules or frame options).
        app = normalize({ ...localManifest(ua.id, validateWebAppFields(ua), ua), custom: true, installed: true });
      } catch (e) {
        console.warn('[registry] skipping malformed user app', ua.id, e.message);
        continue;
      }
      catalog.push(app);
      byId.set(app.id, app);
    }
    await this.loadCatalog();
    bus.emit('registry:changed');
    return catalog;
  },

  /**
   * Load the installable app catalog (static/catalog.json for now). Non-fatal:
   * a missing/invalid catalog just yields an empty "Available" list. This is
   * the single place a future remote catalog would hook in.
   */
  async loadCatalog() {
    try {
      const doc = await fetch('catalog.json').then((r) => (r.ok ? r.json() : null));
      const apps = Array.isArray(doc?.apps) ? doc.apps : [];
      catalogApps = apps.filter((a) => a && a.id && a.type === 'web-app');
      catalogById.clear();
      for (const a of catalogApps) catalogById.set(a.id, a);
    } catch (e) {
      console.warn('[registry] catalog unavailable', e.message);
      catalogApps = [];
      catalogById.clear();
    }
    return catalogApps;
  },

  /** Installable catalog entries, each tagged with its live install state. */
  catalog() {
    return catalogApps.map((a) => ({ ...a, installed: this.isInstalled(a.id) }));
  },
  catalogEntry: (id) => catalogById.get(id),

  /** Everything the user can see (internal hosts such as the game player are hidden). */
  all: () => catalog.filter((a) => !a.hidden),
  installed: () => catalog.filter((a) => a.installed && !a.hidden),
  get: (id) => byId.get(id),
  isInstalled: (id) => !!byId.get(id)?.installed,

  /** Permissions granted to an app by its (host-controlled) manifest. */
  permissions: (id) => byId.get(id)?.permissions || [],
  /** Does an app's manifest grant a given capability? */
  hasPermission: (id, perm) => (byId.get(id)?.permissions || []).includes(perm),

  async install(id) {
    try {
      await api.post(`/apps/${id}/install`);
    } catch (e) {
      if (!navigator.onLine || e instanceof TypeError) this._localToggle(id, true);
      else throw e;
    }
    const app = byId.get(id);
    if (app) app.installed = true;
    bus.emit('registry:changed', { id, installed: true });
  },

  async uninstall(id) {
    const app = byId.get(id);
    if (app?.system) throw new Error(`${app.name} is a system app`);
    if (app?.local) return this.removeLocal(id); // user app: only the local manifest
    try {
      await api.del(`/apps/${id}`);
    } catch (e) {
      if (e instanceof TypeError) this._localToggle(id, false);
      else throw e;
    }
    if (app?.custom) {
      catalog = catalog.filter((a) => a.id !== id);
      byId.delete(id);
    } else if (app) app.installed = false;
    bus.emit('registry:changed', { id, installed: false });
  },

  /** Register any website as a desktop app (a `web-app`, rendered by apps/webapp.js). */
  async addCustom({ name, url, color, proxy }) {
    const app = normalize(await api.post('/apps/custom', { name, url, color, proxy }));
    catalog.push(app);
    byId.set(app.id, app);
    bus.emit('registry:changed', { id: app.id, installed: true });
    return app;
  },

  /**
   * Create a web app from the OS itself and persist it in localStorage
   * (no backend). Produces a standard registry manifest:
   *   { id, name, type: "web-app", runtime, target, iconUrl? }
   * `runtime` is one of the ids in core/runtimes.js (RUNTIMES).
   */
  createLocal(input, opts = {}) {
    const fields = validateWebAppFields(input);
    // opts.id fixes the app id (used when installing a catalog app so its
    // identity matches the catalog entry). It must never overwrite a built-in.
    let id = opts.id;
    if (id) {
      const existing = byId.get(id);
      if (existing && !existing.local) throw new Error(`An app with the id "${id}" already exists.`);
      if (existing && existing.local) return existing; // already installed — no duplicate
    } else {
      id = uniqueId(fields.name);
    }
    const manifest = localManifest(id, fields, opts.extra || {});
    // Dedup by id so a fixed-id install can never leave two entries.
    const stored = userApps().filter((a) => a.id !== id);
    stored.push(manifest);
    saveUserApps(stored);

    const app = normalize({ ...manifest, custom: true, installed: true });
    catalog.push(app);
    byId.set(app.id, app);
    bus.emit('registry:changed', { id: app.id, installed: true });
    return app;
  },

  /**
   * Install a catalog app. Reuses the single local-install path
   * (validate → createLocal → localStorage); the installed app's id equals the
   * catalog id, which is how installed/available state is later detected.
   * Uninstalling removes only the local install; the catalog entry remains.
   */
  installFromCatalog(id) {
    const entry = catalogById.get(id);
    if (!entry) throw new Error('Unknown catalog app.');
    if (byId.get(id)?.local) return byId.get(id); // already installed
    return this.createLocal(
      { name: entry.name, target: entry.target, runtime: entry.runtime, icon: entry.iconUrl },
      { id, extra: { catalogId: id, description: entry.description, version: entry.version, icon: entry.icon } },
    );
  },

  /**
   * Edit a user-created app in place. The id is preserved (never editable),
   * localStorage and the live catalogue are updated, and the app keeps its
   * position/availability in the launcher.
   */
  editLocal(id, input) {
    const stored = userApps();
    const idx = stored.findIndex((a) => a && a.id === id);
    if (idx < 0) throw new Error('This app is not a user-created app.');
    const fields = validateWebAppFields(input);
    // Preserve allowlisted display fields (catalogId, description, version,
    // icon) across edits; anything else in the stored entry is dropped.
    const manifest = localManifest(id, fields, stored[idx]);
    stored[idx] = manifest;
    saveUserApps(stored);

    const app = normalize({ ...manifest, custom: true, installed: true });
    const ci = catalog.findIndex((a) => a.id === id);
    if (ci >= 0) catalog[ci] = app; // preserve position
    else catalog.push(app);
    byId.set(id, app);
    bus.emit('registry:changed', { id });
    return app;
  },

  /** Remove a user-created app's local manifest (built-in apps are unaffected). */
  removeLocal(id) {
    saveUserApps(userApps().filter((a) => a.id !== id));
    catalog = catalog.filter((a) => a.id !== id);
    byId.delete(id);
    bus.emit('registry:changed', { id, installed: false });
  },

  _localToggle(id, on) {
    const set = new Set(local.get('installed', []));
    on ? set.add(id) : set.delete(id);
    local.set('installed', [...set]);
  },

  /** Dynamically import an app module. */
  async loadModule(id) {
    const app = byId.get(id);
    if (!app) throw new Error(`Unknown app "${id}"`);
    // Fails closed: only names in core/modules.js are ever imported. The
    // specifier is made absolute against this module's own URL (what import()
    // resolves against natively anyway) so a layer that resolves import()
    // arguments against the page URL — some URL-rewriting web proxies do —
    // still gets the right file under a sub-path like /Orion-os/.
    const mod = await import(new URL(`../apps/${trustedModule('app', app.module)}.js`, import.meta.url).href);
    return mod.default;
  },
};

// Keep in sync with installs made from other tabs / sessions.
bus.on('server:app-installed', ({ id }) => {
  const a = byId.get(id);
  if (!a) {
    registry.load(); // a custom app added from another session
  } else if (!a.installed) {
    a.installed = true;
    bus.emit('registry:changed', { id, installed: true });
  }
});
bus.on('server:app-uninstalled', ({ id }) => {
  const a = byId.get(id);
  if (a && a.installed) {
    a.installed = false;
    bus.emit('registry:changed', { id, installed: false });
  }
});
