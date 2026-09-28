# Orion OS

Orion OS is a web platform for games and media that looks and works like a desktop operating system. The backend is Rust (Axum) and serves the API, content catalogues, a content proxy and a WebSocket event bus. The frontend is plain ES modules with no framework and no build step.

Websites become applications: a registry entry turns any site into an app window without browser chrome, while Orion remains the one general-purpose browser. Both share the same web container and a self-hosted, security-hardened web layer in the Rust server.

**Naming.** The product is Orion OS (formerly LTF OS). The Orion *browser* is a separate app that runs inside it. Compatibility identifiers keep the `ltf` prefix so that existing apps, stored data and deployments keep working: the `window.ltf` API and `/ltf-api.js`, `ltf:` localStorage keys, the `X-LTF-Client` header, `x-ltf-*` response headers, `LTF_*` environment variables, service-worker cache names, and the `ltf-os` crate/binary name.

## Quick start

```bash
cargo run --release
# → http://localhost:8080
```

`cargo test` runs the backend tests: SSRF address filtering, URL/protocol/port validation, allowlist matching, framing-policy evaluation, rate limiting, HTML rewriting, the app-id migration, catalogue validation, JSON merge-patch and path-traversal rejection.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `LTF_MODE` | `development` | `production` for the live website: loopback bind, access key and trusted hostname required (`beta` is accepted as the old name). See [docs/deployment.md](docs/deployment.md). |
| `LTF_BIND` | `0.0.0.0` (`127.0.0.1` in production) | Listen address |
| `PORT` | `8080` | HTTP port |
| `LTF_ALLOWED_HOSTS` | *(empty)* | Exact hostnames trusted in `Host` besides `localhost` and IP literals, e.g. `beta.example.com`. No wildcards. |
| `LTF_ACCESS_KEY_FILE` / `LTF_ACCESS_KEY` | *(unset)* | Private access key (at least 16 characters). When set, every route except `/login`, `/logout` and `/healthz` requires signing in. Prefer the file form. |
| `LTF_SESSION_HOURS` | `168` | Lifetime of "Keep me signed in", from 1 to 720 hours. Other sign-ins end when the browser closes, or after 12 hours at most. |
| `LTF_DATA_DIR` | `data` | Runtime state: prefs, installs, web apps, Notepad documents |
| `LTF_STATIC_DIR` | `static` | Frontend files |
| `LTF_CONTENT_DIR` | `content` | Content catalogues (music, games, YouTube, wallpapers). Re-read on every request. |
| `LTF_PROXY` | `1` | Set to `0` to disable isolated mode and `/net/` fetching |
| `LTF_PROXY_ALLOW` | *(empty)* | Comma-separated host allowlist, e.g. `wikipedia.org,archive.org`. Subdomains match. Empty means any public host. |
| `LTF_RATE_LIMIT` | `240` | Web-layer requests per client per minute. The burst is half of that. |
| `LTF_TRUST_PROXY_HEADERS` | `0` | Use `X-Forwarded-For` for rate limiting. Only enable behind your own reverse proxy. |
| `LTF_USE_ENV_PROXY` | `0` | Send outbound requests through `HTTPS_PROXY`. Off by default because an intermediate proxy re-resolves DNS, which defeats address pinning. |
| `LTF_PROXY_ALLOW_PRIVATE` | `0` | **Development or trusted intranet only.** Lets the web layer reach private and loopback addresses. |
| `LTF_NETCHECK_URL` | *(built-in)* | Fixed destination for the Network widget's connectivity probe; empty disables it. |
| `YOUTUBE_API_KEY` | *(unset)* | YouTube Data API v3 key. Enables search in the YouTube app. |
| `RUST_LOG` | `ltf_os=info` | Log filter. Web-layer events are logged under `ltf_os::web`. |

### Beta 0.1

Orion OS Beta 0.1 is a working desktop:
- **Entry and desktop:** splash, first-visit welcome, desktop, launcher and dock.
- **Apps:** Orion browser, YouTube, GeForce NOW, Spiceify, Notepad, App Store, Settings, and the Clock, System Monitor and Network widgets.
- **Games:** Vapor, the gaming hub, with *Local Gaming* (Recently Played, Installed, Available, Favorites, Categories) and *Cloud Gaming*.
- **Browser launchers:** Roblox, CineJoy and Netflix.

Sites that don't permit embedding aren't forced into windows: their Orion app opens them in your normal browser. Orion never proxies or rewrites them, and `LTF_PROXY=0` stays the production default.

It runs as the **full edition** (Rust server) or the **static edition** (GitHub Pages, no server). See [docs/static-edition.md](docs/static-edition.md).

### Putting it online

Orion OS runs as a normal HTTPS website on your own server (a VPS behind Caddy or nginx, with `LTF_MODE=production` and an access key). It is not deployed through GitHub or GitHub Pages; the repository stays private.

- [docs/put-orion-online.md](docs/put-orion-online.md): the beginner's step-by-step guide.
- [docs/deployment.md](docs/deployment.md): the reference, covering configuration, DNS, firewall, updates, backups and troubleshooting.
- [`deploy/`](deploy): the tested configs (Caddyfile, nginx, env file, systemd unit) and the `update.sh` and `backup.sh` scripts.
- [docs/deployment-checklist.md](docs/deployment-checklist.md): a checklist for testing on real devices.

## The desktop

- **Startup and entry:** a short Orion splash reports the real startup steps (preferences, apps, desktop, wallpaper) and says so honestly if the server is unavailable. It lasts about a second on the first visit, less afterwards, and none with Settings → System → *Fast startup* or reduced motion. `Esc` skips it. The first visit in a browser shows a one-time welcome (*Enter Orion*). `Ctrl+Alt+L` or Start → Lock shows the lock screen. The lock screen is a local screen cover, not authentication: the server sign-in is the security boundary.
- **Live wallpaper:** a `<video autoplay loop muted playsinline>` layer. Wallpapers crossfade and pause when the tab is hidden, when animation is turned off, or under `prefers-reduced-motion`. If a video can't play, its poster image is shown, then a canvas gradient.
- **Taskbar:** docks to the bottom, top, left or right. Change it by right-clicking the taskbar or desktop, or in Settings → Taskbar. It has the Start button, pinned and running apps, a network indicator (browser online state, server reachability and measured round-trip latency) and a clock with a calendar.
- **Drag and drop:**
  - Drag an app from the taskbar or Start onto the desktop to make a shortcut. It snaps to the grid.
  - Drag a desktop icon onto the taskbar to pin it at that position.
  - Rearrange desktop icons by dragging; dropping on an occupied cell swaps them.
- **Windows:** drag, resize from 8 edges, snap (top edge maximizes, left/right edges tile), minimize into the taskbar icon, maximize and restore. Iframes are given focus correctly, and their pointer events are paused during drags so a drag can't get stuck inside embedded content.

## Applications

The registry (`static/apps.json`) has three kinds of app. Every web-based app, whether a mini-browser or Orion, sits on the same web container (`static/js/core/frame.js`). The kinds differ only in how much control they expose:

| `type` | Chrome | Navigation | Rendered by |
|---|---|---|---|
| `browser` | Address bar, tabs, back/forward/reload, bookmarks, mode switch | Full: the user decides where to go | `apps/orion.js` |
| `web-app` | None. Optional title-bar buttons (`reload`, `home`, `external`, `panel`) | Limited: the site moves within itself; links to other sites open in Orion | `apps/webapp.js` (shared by every web-app) |
| `native` | App-specific | — | `apps/<module>.js` |

| App | Type | Target / notes |
|---|---|---|
| **Orion** | browser | User-controlled. *Direct* mode (default) or *Isolated* mode, which renders through `/proxy/page` and keeps the address bar in sync. |
| **Netflix** | web-app | `https://cinejoy.pk/`. Loaded as the real site in a dedicated window; there is no recreated UI. |
| **YouTube** | web-app | `https://www.youtube.com/`. youtube.com forbids embedding, so the app's `fallback` shows YouTube's official embed player and Data API. |
| **GeForce NOW** | web-app | `https://play.geforcenow.com/`, with gamepad, fullscreen and keyboard permissions. The ⓘ panel shows live latency, controllers and codec support. |
| **Spiceify** | native | Audio player plus streaming embeds (`content/music.json`) |
| **Vapor** | native | Game store and library. Each game opens in the hidden `webplayer` web-app, which unloads while minimized. |
| **App Store**, **Notepad**, **Settings** | native | — |

### Adding a website as an app

One entry in `static/apps.json`. Only `id`, `name`, `type` and `target` are required:

```json
{ "id": "example", "name": "Example", "type": "web-app", "target": "https://example.com/" }
```

Optional fields, all with defaults:

```jsonc
{
  "icon": "web",                        // or a key of tileArt/icons in js/core/icons.js
  "category": "Web", "description": "", "default_size": [1180, 740],
  "navigation": "limited",              // "limited" | "none" (pinned to target)
  "controls": ["reload", "home", "external"],   // title-bar buttons; "panel" opens `panel`
  "proxy": "off",                       // "off" (direct iframe) | "isolated" (/proxy/page sandbox)
  "allow": "autoplay; fullscreen",      // iframe permissions policy
  "sandbox": null,                      // null = no sandbox; omitted = safe default
  "fallback": "youtube",                // module to show when the target can't be displayed
  "panel": "geforcenow",                // apps/panels/<name>.js side panel
  "suspendOnMinimize": false            // unload while minimized (saves memory/CPU)
}
```

Users can do the same at runtime: **App Store → Add web app**, stored in `data/custom_apps.json`. A native app is a module in `static/js/apps/<id>.js` exporting `mount(body, ctx)`. `ctx.win.setControls()` adds title-bar buttons.

## Adding content

All catalogues live in `content/`. They are plain JSON, served by `GET /api/content/<kind>` and re-read on every request, so no restart is needed. Each file has a `_readme` field describing its schema.

```jsonc
// content/games.json — one game
{ "id": "my-game", "title": "My Game", "genres": ["Action"], "cover": "games/covers/my-game.png",
  "launch": { "type": "iframe", "url": "https://games.example.com/my-game/", "size": [1280, 720] } }
  // type: "iframe" | "isolated" | "external"
```

**Wallpapers:** drop any `.mp4`/`.webm`/`.mov` loop into `static/media/wallpapers/` and it appears in Settings automatically. A same-named `.jpg`/`.png`/`.webp` becomes its poster. Alternatively, list it in `content/wallpapers.json`, which also accepts absolute URLs. The default *Aurora Ridge* loop is original and was rendered with `tools/wallpaper/`.

## Web layer (proxy and fetching)

The web layer is self-hosted inside the Rust server (`src/web/`, built on `reqwest`), so no third-party proxy API is involved. I evaluated the common free, self-hosted web proxies, Ultraviolet and Scramjet. Both are Node services built for filter evasion: they rewrite page JavaScript and strip sites' security headers by design. That conflicts with this project's rules, so Orion OS uses its own narrower layer.

```text
App window (web-app / Orion tab)
   │ 1  GET /api/web/inspect?url=…      preflight: validate, SSRF-check, follow redirects,
   │                                     read framing policy (cached 5 min)
   │ 2a <iframe src="https://site/…">   direct: the site's own origin, cookies, CSP and DRM;
   │                                     Orion OS never sees this traffic
   │ 2b <iframe src="/proxy/page?url=…"> isolated: opaque-origin sandbox, no cookies,
   │                                     navigation reported back via postMessage
   │ 3  /net/<encoded-url>              resources and data (favicons, thumbnails, feeds, APIs)
   ▼
Service worker (static/sw.js) — caches /net/ images/fonts, coalesces requests, offline shell;
                                never touches /api, /proxy, /ws, media ranges or cross-origin
   ▼
src/web: guard → client → policy → limit → error
   ▼
Remote website / API
```

### API

| Endpoint | Purpose |
|---|---|
| `GET /api/web/inspect?url=` | Returns `{ ok, final_url, status, content_type, embeddable, blocked_by, isolated_available }`, or `{ error: { code, message } }` |
| `GET /proxy/page?url=` | Isolated document rendering. Redirects bounce back through the endpoint so every hop is re-validated. |
| `GET /net/<encodeURIComponent(url)>` | Resource fetch, the internal URL namespace. The frontend helper is `netUrl()` in `js/core/api.js`. |
| `GET /proxy/fetch?url=` | Same as `/net/`, in query form |

Error codes are shared by the backend and the native error screens: `INVALID_URL`, `BLOCKED_REQUEST`, `EMBEDDING_NOT_ALLOWED`, `SITE_UNAVAILABLE`, `NETWORK_TIMEOUT`, `PROXY_ERROR`, `PROXY_DISABLED`, `SERVER_ERROR`, `UNSUPPORTED_CONTENT`, `RATE_LIMITED`, `TOO_LARGE`.

### What is and isn't done

- **Respected, never bypassed:** `X-Frame-Options` and CSP `frame-ancestors`. A page that forbids embedding is never shown in a window, in either direct or isolated mode; `/proxy/page` itself refuses it too. The window shows `EMBEDDING_NOT_ALLOWED` with **Open in browser tab**.
- **Never forwarded:** cookies, `Authorization`, or any credential, in either direction. Logins, paywalls, access controls, DRM and bot checks stay exactly as the site set them.
- **Isolated mode** re-hosts a page, so the site's CSP (whose `'self'` would now mean Orion OS) is replaced by a *stricter* sandbox with an opaque origin and no storage or cookies. Subresources load directly from the origin and are not proxied.

### Security controls

| Threat | Control |
|---|---|
| SSRF / internal network access | Only `http`/`https`. No embedded credentials. Ports limited to 80, 443 or ≥1024. Internal host names (`*.internal`, `*.local`, metadata hosts) are denied. **Every** resolved address must be public: loopback, RFC 1918, link-local/metadata, CGNAT, ULA, NAT64, 6to4 and IPv4-mapped addresses are all rejected. |
| DNS rebinding | Each connection is pinned to the address that was validated. The environment proxy is off by default, since it would re-resolve DNS. |
| Redirect tricks | Redirects are never followed automatically. Every hop (at most 5) goes through the full guard again. |
| Resource abuse | Token-bucket rate limit per client, 5 s DNS / 8 s connect / 20 s total timeouts, and size caps of 6 MB for HTML and 32 MB for resources. `CORP: same-origin` stops other sites from hotlinking `/net/`. |
| Proxied content attacking Orion OS | `/proxy/page` uses a CSP `sandbox` without `allow-same-origin`, so proxied pages get an opaque origin. `/net/` responses are served with `sandbox` (no scripts) and `nosniff`. |
| Direct iframes | Sandboxed without `allow-top-navigation`, so an embedded site can't navigate the OS away. |
| CSRF against the API | State-changing calls need an `X-LTF-Client` header, which forces a CORS preflight that no other origin can pass. |
| Auditing | Structured logs under `ltf_os::web`: mode, host, status, latency and every block reason. |

### Performance

- Preflight results are cached: 5 minutes on the server and 60 seconds on the client.
- Direct iframes add no proxy overhead at all.
- The service worker caches `/net/` images and fonts (LRU of 300 entries, 7 days) and coalesces identical in-flight requests.
- Minimized windows stop painting (`visibility: hidden`) while their media keeps playing. Apps with `suspendOnMinimize` (game windows) unload entirely and reload on restore.
- The wallpaper video pauses while a maximized window covers it.

## Theming

All visual values are CSS custom properties defined in `static/css/system/tokens.css`. The main ones:

| Token | Meaning |
|---|---|
| `--accent-color` | Primary accent. Set from Settings; `--accent-color-2`, `-soft`, `-strong` and `-contrast` are derived from it. |
| `--system-glass-opacity` | Opacity of every Acrylic/Mica surface. There's a slider for it in Settings. |
| `--system-glass-rgb`, `--system-glass-blur`, `--system-glass-saturate`, `--system-glass-border` | Tint, blur and edge of glass surfaces |
| `--tb-size`, `--radius*`, `--font`, `--ease`, `--dur*` | Geometry, type and motion |
| `--wallpaper-dim` | Darkens the wallpaper for legibility |

The stylesheets are split into a system layer (`css/system/`: tokens, base, boot, desktop, taskbar, flyouts, windows, menus) and an app layer (`css/apps/`, one file per app).

## Project layout

```
src/
  main.rs            router, CSRF guard, static files (range requests), connect-info for rate limits
  config.rs          environment configuration
  state.rs           prefs (+ app-id migrations), installs, custom web apps, caches, WebSocket bus
  catalog.rs         app registry schema (defaults + passthrough fields), embeds static/apps.json
  web/               the web layer — see "Web layer" above
    mod.rs             architecture overview
    guard.rs           URL / protocol / port / host / address validation (SSRF)
    client.rs          pinned outbound client, per-hop redirect validation, header allowlist
    policy.rs          X-Frame-Options / frame-ancestors evaluation
    inspect.rs         /api/web/inspect (+ cache)
    page.rs            /proxy/page isolated documents (+ navigation shim)
    fetch.rs           /net/… and /proxy/fetch resources
    limit.rs           token-bucket rate limiter
    error.rs           error codes, JSON + HTML error responses
  handlers/          apps, content, files, prefs, system, youtube, ws
content/             creator catalogues (JSON)
static/
  apps.json          app registry
  sw.js              service worker
  css/system/ …      design tokens + system components
  css/apps/ …        per-app styles
  js/core/frame.js   web container (preflight, direct/isolated, error screens, suspend)
  js/core/           wm, taskbar, startmenu, desktop, dnd, wallpaper, boot, store, api, theme, …
  js/apps/           orion (browser), webapp (every web-app), native apps, panels/, youtube (fallback)
  games/             bundled HTML5 games + covers
  media/wallpapers/  live wallpaper loops
tools/wallpaper/     frame-exact WebCodecs renderer for original wallpaper loops
```

## Trademarks and content

App names such as "Netflix", "YouTube" and "GeForce NOW" belong to their owners. **The Netflix app points to cinejoy.pk, which is not Netflix.** Labelling a third-party site with another company's name and logo can mislead users and infringe trademarks. Before any public deployment, give that app a neutral name and icon: change `name` and `icon` in its `static/apps.json` entry, since everything else reads from there. Also confirm that you are permitted to present any target site this way; the web container only embeds what a site allows, but licensing of the content itself is your responsibility.
