# System stats API — `GET /api/system/stats`

Read-only, live host statistics for **first-party LTF UI** (future desktop
widgets such as a system monitor). Internal: it is not part of `window.ltf`
and is not offered to web apps.

## Response

Fixed schema (`schema: 1`). A field is `null` where the platform can't report
it (`platform.supported: false` means every metric is `null`).

```json
{
  "schema": 1,
  "sampled_at_ms": 1790288944937,
  "platform": { "os": "linux", "arch": "x86_64", "supported": true },
  "uptime_seconds": 1612,
  "cpu": { "usage_percent": 0.3, "logical_cores": 4 },
  "memory": { "total_bytes": 16877547520, "used_bytes": 628224000, "available_bytes": 16249323520 }
}
```

| Field | Meaning |
|---|---|
| `schema` | Response version; bumped on incompatible changes. |
| `sampled_at_ms` | Unix ms when the host was last read. |
| `platform.os` / `.arch` | `std::env::consts::OS` / `ARCH`. |
| `platform.supported` | Whether this platform can report stats at all. |
| `uptime_seconds` | **Host** uptime (the server's own uptime stays in `/api/system/info`). |
| `cpu.usage_percent` | Whole-system CPU, 0–100, one decimal. `null` until two readings exist (just after server start). |
| `cpu.logical_cores` | Logical CPU count. |
| `memory.*_bytes` | RAM total / used / available as the OS reports it. In a container this is what the kernel exposes via `/proc/meminfo`, which may be the host's figures rather than a cgroup limit. |

Source: the `sysinfo` crate, built with only its `system` feature
(`src/sysstats.rs`).

## Freshness

Responses are sent with `Cache-Control: no-store`, and the service worker never
intercepts `/api/*`. CPU usage is a delta between two readings, so the server
re-reads the host at most once per `sysinfo::MINIMUM_CPU_UPDATE_INTERVAL`
(200 ms on Linux/macOS/Windows); requests arriving faster get the latest
reading (compare `sampled_at_ms`). This also caps the host work a burst of
requests can cause. Consumers should poll at a UI-appropriate interval (e.g.
1–5 s); there is no push/streaming.

```js
import { api } from '../core/api.js';
const stats = await api.get('/system/stats');
```

## Security boundary

- **Read-only.** GET only; other methods are refused (403 without
  `X-LTF-Client`, 405 with it). Nothing writes to the host, runs a command or
  starts a process.
- **No parameters.** Query strings are ignored; nothing in a request can
  select a file, process, command or resource.
- **Allowlisted output.** Only the fields above. No hostname, users, home
  directories, paths, environment variables, process lists, command lines,
  disks, network interfaces or credentials. The `sysinfo` features that could
  enumerate users, disks, networks or components are not compiled in.
- **Who can read it.** Same boundary as every `/api/*` route: the server sends
  no CORS headers, so only same-origin (first-party LTF) pages can read the
  response. Cross-origin web apps (direct/embed) and opaque-origin
  `/proxy/page` documents cannot. A route test pins the "no CORS headers"
  property.
- Tests: `src/sysstats.rs` (sampler) and the route tests in `src/main.rs`.

## First consumer: the System Monitor widget

`static/js/widgets/sysmon.js` is the first first-party desktop widget and the
first consumer of this endpoint. It shows live CPU %, memory % and used/total,
host uptime and platform (os · arch), polling every 2 s via `api.get('/system/stats')`.
It keeps the last good values during an outage, shows an "Offline · retrying"
state, and recovers automatically. It renders `—` (not `0%`) when
`cpu.usage_percent` is null. Widgets mount through the small host in
`static/js/core/widgets.js` into the `#widgets` desktop layer; add a new
first-party widget by adding its module to that host's `WIDGETS` list.

---

# Network stats API — `GET /api/network/stats`

Read-only server-side connectivity/latency for first-party desktop UI (the
Network widget). Same `/api` boundary and conventions as `/api/system/stats`:
GET-only, `Cache-Control: no-store`, no CORS, same-origin only, and it is not
part of `window.ltf`.

## Response

Fixed schema (`schema: 1`):

```json
{ "schema": 1, "sampled_at_ms": 1790290306632, "online": true, "latency_ms": 1.6 }
```

| Field | Meaning |
|---|---|
| `schema` | Response version. |
| `sampled_at_ms` | Unix ms of the last probe (or of startup, before the first). |
| `online` | Whether the **server** reached the configured destination on the last probe. |
| `latency_ms` | Server→destination round-trip in ms (one decimal), or `null` when the last probe failed or the check is disabled. |

## What `latency_ms` measures — and what it does NOT

`latency_ms` is the time for the **LTF server** to complete one lightweight HTTP
GET to a single, **server-configured** destination (`LTF_NETCHECK_URL`, default
`https://cloudflare.com/cdn-cgi/trace`). It is the **server's** network path.

It is **not** the user's browser "ping". If LTF runs on the user's own machine
the two are similar; if LTF is hosted remotely, this measures the server's path,
not the user's. The widget labels it "Network latency / server → network"
accordingly, never "your ping".

`online` is derived from the same probe: a probe that gets any HTTP response
(even 4xx/5xx) counts as reached; a connect failure or timeout is offline.

## Sampling / caching

A real probe runs at most once per **20 s** (`netstats::MIN_REFRESH`), with a
4 s per-probe timeout. It is single-flight: only one probe is ever in flight,
and requests arriving in between share the cached snapshot (compare
`sampled_at_ms`). So rapid requests cannot turn the endpoint into a traffic
generator — 25 requests in a burst cause exactly one outbound probe.

## Security boundary

- **No destination selection.** The target is fixed by server configuration and
  can never be chosen by a request — no URL/host/IP/port parameter, no DNS from
  user input, no `ping`/subprocess, no interface enumeration, no port scanning.
  Query strings are ignored.
- **Read-only.** GET only (403 without `X-LTF-Client`, 405 with it).
- **Minimal output.** Only the four fields above — no IPs, hostnames, interface
  names, MACs, SSIDs, routes, DNS config or credentials (the response contains
  no strings at all). The probe client sends no cookies/credentials and does not
  follow redirects.
- **Config.** `LTF_NETCHECK_URL` overrides the destination; set it empty to
  disable the check (then `online` is always `false`, `latency_ms` `null`). The
  probe client is built with `no_proxy`, so it measures this server's own path.
- Tests: `src/netstats.rs` (sampler, with a local mock) and the route tests in
  `src/main.rs`; `tests/browser/netmon.browser.mjs` (widget).
