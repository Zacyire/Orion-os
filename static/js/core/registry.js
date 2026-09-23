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
// (createLocal / removeLocal). Built-in ids always take precedence.

import { api } from './api.js';
import { bus } from './events.js';
import { local } from './dom.js';

let catalog = [];

const USER_APPS_KEY = 'user-apps';
/** User-created web apps, persisted in localStorage (Step 4). */
function userApps() {
  const list = local.get(USER_APPS_KEY, []);
  return Array.isArray(list) ? list : [];
}
function saveUserApps(list) {
  local.set(USER_APPS_KEY, list);
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
    module: a.module || (type === 'web-app' ? 'webapp' : type === 'browser' ? 'orion' : a.id),
  };
}
const byId = new Map();

export const registry = {
  async load() {
    let apps;
    try {
      apps = await api.get('/apps');
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
    // user manifest can never shadow or alter a built-in app.
    for (const ua of userApps()) {
      if (byId.has(ua.id)) continue;
      const app = normalize({ ...ua, type: 'web-app', custom: true, local: true, installed: true });
      catalog.push(app);
      byId.set(app.id, app);
    }
    bus.emit('registry:changed');
    return catalog;
  },

  /** Everything the user can see (internal hosts such as the game player are hidden). */
  all: () => catalog.filter((a) => !a.hidden),
  installed: () => catalog.filter((a) => a.installed && !a.hidden),
  get: (id) => byId.get(id),
  isInstalled: (id) => !!byId.get(id)?.installed,

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
   * `runtime` is the Step-3 field (direct | embed | external).
   */
  createLocal({ name, target, runtime = 'direct', icon }) {
    name = (name || '').trim();
    if (!name) throw new Error('Name is required.');
    if (!['direct', 'embed', 'external'].includes(runtime)) runtime = 'direct';
    let url;
    try {
      url = new URL(target.trim());
    } catch {
      throw new Error('Enter a valid URL, including https://');
    }
    if (!/^https?:$/.test(url.protocol)) throw new Error('Only http and https URLs are supported.');

    const stored = userApps();
    const manifest = { id: uniqueId(name), name, type: 'web-app', runtime, target: url.href };
    if (icon && /^https?:\/\//i.test(icon.trim())) manifest.iconUrl = icon.trim();
    stored.push(manifest);
    saveUserApps(stored);

    const app = normalize({ ...manifest, custom: true, local: true, installed: true });
    catalog.push(app);
    byId.set(app.id, app);
    bus.emit('registry:changed', { id: app.id, installed: true });
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
    const mod = await import(`../apps/${app.module}.js`);
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
