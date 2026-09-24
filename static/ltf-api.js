// LTF App API — client shim.
//
// Include in a FIRST-PARTY LTF app page (a page served from the LTF OS origin
// and shown in an app window):
//
//   <script src="/ltf-api.js"></script>
//
// It exposes `window.ltf` inside that page and talks to the OS over
// postMessage. It exposes no OS internals — only this app's own metadata, a few
// request methods, and its own isolated storage namespace. Cross-origin app
// frames (direct/embed web apps) and
// proxied/isolated frames are NOT granted the API: the OS bridge only answers
// same-origin, non-proxied app frames (see static/js/core/appbridge.js). In
// those runtimes `window.ltf` simply never receives metadata and requests are
// ignored, rather than isolation being weakened.
(function () {
  if (window.top === window.self) return; // only meaningful inside an app frame
  var host = window.parent;
  // `permissions` lists the capability ids the host granted this app via its
  // manifest. It is read-only, informational metadata — the host enforces
  // capabilities regardless of what an app believes it has.
  var app = { id: null, name: null, version: null, permissions: [] };
  var waiters = [];
  // Pending request/reply calls (storage, window), keyed by a per-frame id.
  var pending = {};
  var reqSeq = 0;
  // Window lifecycle listeners (ltf.window.onStateChange).
  var winListeners = [];
  var winSubscribed = false;

  function post(msg) {
    try { host.postMessage(Object.assign({ source: 'ltf-app' }, msg), '*'); } catch (e) { /* isolated */ }
  }

  // Send a request the host answers, returning a Promise. Structured-clone
  // failures (functions, DOM nodes, …) reject here rather than throwing.
  function request(type, msg) {
    return new Promise(function (resolve, reject) {
      var rid = 'r' + (++reqSeq);
      pending[rid] = { resolve: resolve, reject: reject };
      try {
        host.postMessage(Object.assign({ source: 'ltf-app', type: type, rid: rid }, msg), '*');
      } catch (e) {
        delete pending[rid];
        reject(new Error('value is not serializable'));
      }
    });
  }

  window.addEventListener('message', function (e) {
    if (e.source !== host) return;
    var d = e.data;
    if (!d || d.source !== 'ltf-host') return;
    if (d.type === 'app' && d.app) {
      app.id = d.app.id;
      app.name = d.app.name;
      app.version = d.app.version;
      app.permissions = Array.isArray(d.app.permissions) ? d.app.permissions : [];
      waiters.splice(0).forEach(function (r) { r(app); });
    } else if (d.rid && pending[d.rid]) {
      // Any request/reply result (storage-result, window-result), matched by id.
      var p = pending[d.rid];
      delete pending[d.rid];
      if (d.ok) p.resolve(d.value === undefined ? null : d.value);
      else p.reject(new Error(d.error || 'request failed'));
    } else if (d.type === 'window-event' && d.state) {
      // Lifecycle push for this window; deliver to all listeners.
      winListeners.slice().forEach(function (cb) { try { cb(d.state); } catch (e) { /* listener threw */ } });
    }
  });

  window.ltf = {
    // Read-only metadata about the running app (populated after the handshake).
    app: app,

    /** Resolves with app metadata once the OS handshake completes. */
    ready: function () {
      return app.id ? Promise.resolve(app) : new Promise(function (res) { waiters.push(res); });
    },

    /** Ask the OS to open an http(s) URL in the Orion browser. */
    open: function (url) {
      if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('ltf.open: only http:// and https:// URLs are allowed');
      post({ type: 'open', url: String(url) });
    },

    /** Ask the OS to show an in-OS toast notification. */
    notify: function (title, body) {
      post({ type: 'notify', title: title == null ? '' : String(title), body: body == null ? '' : String(body) });
    },

    // Per-app persistent storage. Each app has its own isolated namespace,
    // enforced host-side by the app's id; an app can never read another app's
    // data or supply its own namespace. Requires the "storage" permission —
    // without it the host rejects each call. Values must be JSON-compatible
    // (string/number/boolean/null/array/plain object); anything else, or a
    // value over the host's per-value size limit, is rejected. All methods
    // return Promises so the backing store can change (e.g. IndexedDB) later.
    storage: {
      /** Resolves with the stored value, or null if the key is missing. */
      get: function (key) { return request('storage', { op: 'get', key: String(key) }); },
      /** Resolves once the value is stored. */
      set: function (key, value) { return request('storage', { op: 'set', key: String(key), value: value }); },
      /** Resolves once the key is removed. */
      remove: function (key) { return request('storage', { op: 'remove', key: String(key) }); },
      /** Resolves once this app's storage is cleared (its namespace only). */
      clear: function () { return request('storage', { op: 'clear' }); },
    },

    // Control and observe this app's OWN window. The host resolves the target
    // window from this iframe, so an app can never reach another window.
    // Requires the "window" permission — without it every call is rejected and
    // no lifecycle events are delivered. All methods return Promises.
    window: {
      /** Resolves with { minimized, maximized, focused } for this window. */
      getState: function () { return request('window', { op: 'getState' }); },
      /** Minimize this window. Resolves with the resulting state. */
      minimize: function () { return request('window', { op: 'minimize' }); },
      /** Maximize this window. Resolves with the resulting state. */
      maximize: function () { return request('window', { op: 'maximize' }); },
      /** Restore this window (un-minimize/un-maximize). Resolves with the state. */
      restore: function () { return request('window', { op: 'restore' }); },

      /**
       * Subscribe to this window's lifecycle changes (focus, minimize, maximize,
       * restore). The callback receives the same shape as getState(). Returns an
       * unsubscribe function; when the last listener is removed the host stops
       * sending events. Listeners also die with the frame when the app closes.
       */
      onStateChange: function (callback) {
        if (typeof callback !== 'function') return function () {};
        winListeners.push(callback);
        if (!winSubscribed) {
          winSubscribed = true;
          request('window', { op: 'subscribe' }).catch(function () { /* not permitted */ });
        }
        return function unsubscribe() {
          var i = winListeners.indexOf(callback);
          if (i >= 0) winListeners.splice(i, 1);
          if (winListeners.length === 0 && winSubscribed) {
            winSubscribed = false;
            request('window', { op: 'unsubscribe' }).catch(function () {});
          }
        };
      },
    },
  };

  post({ type: 'hello' }); // request metadata
})();
