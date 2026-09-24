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
