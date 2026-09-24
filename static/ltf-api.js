// LTF App API — client shim.
//
// Include in a FIRST-PARTY LTF app page (a page served from the LTF OS origin
// and shown in an app window):
//
//   <script src="/ltf-api.js"></script>
//
// It exposes `window.ltf` inside that page and talks to the OS over
// postMessage. It exposes no OS internals — only this app's own metadata plus
// two request methods. Cross-origin app frames (direct/embed web apps) and
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

  function post(msg) {
    try { host.postMessage(Object.assign({ source: 'ltf-app' }, msg), '*'); } catch (e) { /* isolated */ }
  }

  window.addEventListener('message', function (e) {
    if (e.source !== host) return;
    var d = e.data;
    if (!d || d.source !== 'ltf-host' || d.type !== 'app' || !d.app) return;
    app.id = d.app.id;
    app.name = d.app.name;
    app.version = d.app.version;
    app.permissions = Array.isArray(d.app.permissions) ? d.app.permissions : [];
    waiters.splice(0).forEach(function (r) { r(app); });
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
  };

  post({ type: 'hello' }); // request metadata
})();
