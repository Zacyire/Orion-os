// REST + WebSocket client for the Rust API layer.
//
// Every request carries `X-LTF-Client`; the server rejects state-changing
// requests without it (CSRF guard — see require_client_header in main.rs).
// When the backend is unreachable (e.g. a static host) calls reject and
// callers fall back to local behaviour.

import { bus } from './events.js';

export let online = true;

async function request(method, path, body, { raw = false, headers = {} } = {}) {
  const opts = { method, headers: { 'X-LTF-Client': '1', ...headers } };
  if (body instanceof FormData || typeof body === 'string' || body instanceof Blob) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(`/api${path}`, opts);
  } catch (err) {
    setOnline(false);
    throw err;
  }
  setOnline(true);
  // Access gate: the session expired or was signed out elsewhere → show the sign-in page.
  if (res.status === 401 && res.headers.get('content-type')?.includes('json')) {
    const body = await res.clone().json().catch(() => null);
    if (body?.error?.code === 'UNAUTHENTICATED') location.assign('/');
  }
  if (!res.ok) {
    // Errors are either { error: "text" } (API) or { error: { code, message } } (web layer).
    let msg = res.statusText;
    let code = res.status >= 500 ? 'SERVER_ERROR' : undefined;
    try {
      const e = (await res.json()).error;
      if (typeof e === 'string') msg = e;
      else if (e) ({ message: msg, code = code } = e);
    } catch { /* not json */ }
    const err = new Error(msg);
    err.status = res.status;
    err.code = code;
    throw err;
  }
  if (raw) return res;
  const type = res.headers.get('content-type') || '';
  return type.includes('json') ? res.json() : res.text();
}

function setOnline(v) {
  if (online !== v) {
    online = v;
    bus.emit('net', v);
  }
}

/** Isolated document mode: `target` rendered via /proxy/page (sandboxed, opaque origin). */
export const pageUrl = (target) => `/proxy/page?url=${encodeURIComponent(target)}`;

/**
 * Internal URL for a remote resource: `/net/<encoded url>`. Served by the
 * backend (src/web/fetch.rs) and cached by the service worker (sw.js). Use
 * it for images/data the browser can't load or read cross-origin.
 */
export const netUrl = (target) => `/net/${encodeURIComponent(target)}`;

// Preflight results are memoised briefly on the client as well (the server caches for 5 min).
const inspectMemo = new Map();

export const api = {
  get: (p, o) => request('GET', p, undefined, o),
  post: (p, b, o) => request('POST', p, b, o),
  put: (p, b, o) => request('PUT', p, b, o),
  patch: (p, b, o) => request('PATCH', p, b, o),
  del: (p, o) => request('DELETE', p, undefined, o),

  /** Creator content catalogue (content/<kind>.json); empty when offline. */
  async content(kind) {
    try {
      return await api.get(`/content/${kind}`);
    } catch {
      return { items: [] };
    }
  },

  /**
   * Preflight a URL before showing it in a window (src/web/inspect.rs).
   * Resolves to { ok, final_url, status, content_type, embeddable, blocked_by,
   * isolated_available } or rejects with err.code (INVALID_URL, BLOCKED_REQUEST, …).
   */
  inspect(url) {
    const hit = inspectMemo.get(url);
    if (hit && Date.now() - hit.at < 60_000) return hit.promise;
    const promise = api.get(`/web/inspect?url=${encodeURIComponent(url)}`);
    inspectMemo.set(url, { at: Date.now(), promise });
    promise.catch(() => inspectMemo.delete(url));
    return promise;
  },

  /** Round-trip latency to the API server in ms (median of `n` pings). */
  async latency(n = 3) {
    const samples = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      await fetch('/api/ping', { cache: 'no-store' });
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    return Math.round(samples[Math.floor(samples.length / 2)]);
  },

  files: {
    list: () => api.get('/files'),
    read: (name) => api.get(`/files/${encodeURIComponent(name)}`),
    write: (name, text) => api.put(`/files/${encodeURIComponent(name)}`, text, { headers: { 'Content-Type': 'text/plain' } }),
    remove: (name) => api.del(`/files/${encodeURIComponent(name)}`),
    downloadUrl: (name) => `/api/files/${encodeURIComponent(name)}/download`,
    upload(fileList) {
      const fd = new FormData();
      for (const file of fileList) fd.append('file', file, file.name);
      return api.post('/files/upload', fd);
    },
  },
};

// ─── WebSocket event stream ───────────────────────────────────────────────
let retry = 1000;

export function connectEvents() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let ws;
  try {
    ws = new WebSocket(`${proto}://${location.host}/ws`);
  } catch {
    return;
  }
  ws.addEventListener('open', () => {
    retry = 1000;
    setOnline(true);
  });
  ws.addEventListener('message', (e) => {
    try {
      const msg = JSON.parse(e.data);
      bus.emit(`server:${msg.type}`, msg.data);
    } catch { /* ignore malformed */ }
  });
  ws.addEventListener('close', () => {
    setOnline(false);
    setTimeout(connectEvents, retry);
    retry = Math.min(retry * 2, 30000);
  });
}
