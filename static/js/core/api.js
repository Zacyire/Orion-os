// REST + WebSocket client for the Rust backend.
// When the backend is unreachable (e.g. opened from a static host) calls
// reject and callers fall back to local behaviour; metrics are simulated.

import { bus } from './events.js';

export let online = true;

async function request(method, path, body, { raw = false, headers = {} } = {}) {
  const opts = { method, headers: { ...headers } };
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
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).error || msg;
    } catch { /* not json */ }
    throw new Error(msg);
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

export const api = {
  get: (p, o) => request('GET', p, undefined, o),
  post: (p, b, o) => request('POST', p, b, o),
  put: (p, b, o) => request('PUT', p, b, o),
  patch: (p, b, o) => request('PATCH', p, b, o),
  del: (p, o) => request('DELETE', p, undefined, o),

  // convenience wrappers
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
let ws;
let retry = 1000;
let simTimer;

export function connectEvents() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  try {
    ws = new WebSocket(`${proto}://${location.host}/ws`);
  } catch {
    return startSimulation();
  }
  ws.addEventListener('open', () => {
    retry = 1000;
    stopSimulation();
    setOnline(true);
  });
  ws.addEventListener('message', (e) => {
    try {
      const msg = JSON.parse(e.data);
      bus.emit(`server:${msg.type}`, msg.data);
    } catch { /* ignore malformed */ }
  });
  ws.addEventListener('close', () => {
    startSimulation();
    setTimeout(connectEvents, retry);
    retry = Math.min(retry * 2, 15000);
  });
}

// Local metrics simulation so widgets still animate without the backend.
function startSimulation() {
  if (simTimer) return;
  const m = { cpu: 12, cores: Array(8).fill(10), ram_used_mb: 6000, ram_total_mb: 16384, gpu: 8, net_down_kbps: 400, net_up_kbps: 50, temp_c: 44, processes: 140 };
  const walk = (v, s, lo, hi) => Math.min(hi, Math.max(lo, v + (Math.random() * 2 - 1) * s));
  simTimer = setInterval(() => {
    m.cores = m.cores.map((c) => (Math.random() < 0.03 ? 55 + Math.random() * 40 : walk(c, 9, 1, 100)));
    m.cpu = m.cores.reduce((a, b) => a + b, 0) / m.cores.length;
    m.ram_used_mb = walk(m.ram_used_mb, 180, 3500, 14500);
    m.gpu = walk(m.gpu, 6, 1, 100);
    m.net_down_kbps = walk(m.net_down_kbps, 350, 20, 9800);
    m.net_up_kbps = walk(m.net_up_kbps, 60, 5, 2400);
    m.temp_c = 38 + m.cpu * 0.42;
    bus.emit('server:metrics', { ...m, cores: [...m.cores] });
  }, 1000);
}

function stopSimulation() {
  clearInterval(simTimer);
  simTimer = null;
}
