// App Registry — the catalogue of apps, which are installed, and how to
// load each one. Apps are ES modules in /js/apps/<module>.js exporting:
//
//   export default {
//     mount(body, ctx) { ...; return () => cleanup(); }  // required
//     onFocus?(), onResize?()                             // optional hooks
//   }
//
// Adding a new app = add an entry to /apps.json + drop a module file.

import { api } from './api.js';
import { bus } from './events.js';
import { local } from './dom.js';

let catalog = [];
const byId = new Map();

export const registry = {
  async load() {
    let apps;
    try {
      apps = await api.get('/apps');
    } catch {
      // Offline: read the static catalogue and use locally tracked installs.
      const res = await fetch('apps.json');
      const installed = new Set(local.get('installed', ['explorer', 'appstore', 'settings', 'notepad', 'music', 'movies', 'games', 'cloud', 'terminal', 'taskmgr']));
      apps = (await res.json()).map((a) => ({ ...a, installed: a.system || installed.has(a.id) }));
    }
    catalog = apps;
    byId.clear();
    for (const a of apps) byId.set(a.id, a);
    bus.emit('registry:changed');
    return apps;
  },

  all: () => catalog,
  installed: () => catalog.filter((a) => a.installed),
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
    try {
      await api.del(`/apps/${id}`);
    } catch (e) {
      if (e instanceof TypeError) this._localToggle(id, false);
      else throw e;
    }
    if (app) app.installed = false;
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
  if (a && !a.installed) {
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
