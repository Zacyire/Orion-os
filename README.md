# LTF OS

LTF OS is a web platform for games and media that looks and works like a desktop operating system. The backend is Rust (Axum) and serves the API, content catalogues, a content proxy and a WebSocket event bus. The frontend is plain ES modules with no framework and no build step.

Every app runs as an isolated container. It either embeds a real service in an iframe, or plays real media from a catalogue you edit as JSON. There are no mock data sources.

## Quick start

```bash
cargo run --release
# → http://localhost:8080
```

`cargo test` runs the backend tests: SSRF address filtering, proxy target validation, allowlist matching, HTML rewriting, `frame-ancestors` parsing, JSON merge-patch, path-traversal rejection and catalogue validity.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `LTF_DATA_DIR` | `data` | Runtime state: prefs, installs, web apps, Notepad documents |
| `LTF_STATIC_DIR` | `static` | Frontend files |
| `LTF_CONTENT_DIR` | `content` | Content catalogues (see below). Re-read on every request. |
| `LTF_PROXY` | `1` | Set to `0` to disable `/proxy` |
| `LTF_PROXY_ALLOW` | *(empty)* | Comma-separated host allowlist for the proxy, e.g. `wikipedia.org,archive.org`. Subdomains match. Empty means any public host. |
| `LTF_PROXY_ALLOW_PRIVATE` | `0` | **Development or trusted intranet only.** Lets the proxy reach private and loopback addresses. |
| `YOUTUBE_API_KEY` | *(unset)* | YouTube Data API v3 key. Enables search in the YouTube app. |
| `RUST_LOG` | `ltf_os=info` | Log filter |

The outbound client trusts both the bundled Mozilla roots and the operating system's certificate store (including `SSL_CERT_FILE`). This means it also works behind corporate TLS-inspecting proxies.

## The desktop

- **Boot console:** Arch Linux / systemd style kernel and unit output. The unit list comes from `/api/system/boot-log` and reflects real configuration, e.g. whether the proxy is enabled and whether YouTube search is configured. It fades into the desktop when initialisation finishes. `Esc` skips it; Settings → System → *Fast startup* turns it off.
- **Live wallpaper:** a `<video autoplay loop muted playsinline>` layer. Wallpapers crossfade and pause when the tab is hidden, when animation is turned off, or under `prefers-reduced-motion`. If a video can't play, its poster image is shown, then a canvas gradient.
- **Taskbar:** docks to the bottom, top, left or right. Change it by right-clicking the taskbar or desktop, or in Settings → Taskbar. It has the Start button, pinned and running apps, a network indicator (browser online state, server reachability and measured round-trip latency) and a clock with a calendar.
- **Drag and drop:**
  - Drag an app from the taskbar or Start onto the desktop to make a shortcut. It snaps to the grid.
  - Drag a desktop icon onto the taskbar to pin it at that position.
  - Rearrange desktop icons by dragging; dropping on an occupied cell swaps them.
- **Windows:** drag, resize from 8 edges, snap (top edge maximizes, left/right edges tile), minimize into the taskbar icon, maximize and restore. Iframes are given focus correctly, and their pointer events are paused during drags so a drag can't get stuck inside embedded content.

## Apps

| App | Module | What it embeds / plays | Content source |
|---|---|---|---|
| **Orion** | `orion.js` | Any website. Tabs, history, bookmarks, and *Auto / Direct / Proxy* loading modes | User input |
| **NotNetflix** | `notnetflix.js` | Titles as direct video (`mp4`/`webm`), HLS (`.m3u8` via hls.js) or an embed URL. Resume, My List, search | `content/movies.json` |
| **Spiceify** | `spiceify.js` | Audio files through `<audio>` with a Web Audio visualizer, plus streaming-service players (Spotify, SoundCloud, …) as embeds | `content/music.json` |
| **GeForce NOW** | `geforcenow.js` | The cloud-gaming portal, with gamepad, fullscreen, clipboard and microphone permissions. Launcher shows live latency and jitter, connected controllers (Gamepad API), and WebRTC / H.264 / AV1 decode support | `apps.json → geforcenow.embed.url` |
| **Vapor** | `vapor.js` | Game store and library. Each game launches in its own window (iframe, proxied iframe, or a new tab). Tracks play time | `content/games.json` |
| **YouTube** | `youtube.js` | The official embed player (`youtube-nocookie.com`). Curated home feed, search, or paste any link or video ID | `content/youtube.json` + API |
| **App Store** | `appstore.js` | Install and remove apps; **Add web app** turns any URL into a desktop app | `static/apps.json` + `data/custom_apps.json` |
| **Notepad** | `notepad.js` | Text and Markdown editor. Saves to the server (`/api/files`), with upload and download | `data/files/` |
| Settings | `settings.js` | Wallpaper, accent colour, glass opacity, taskbar position, account, sound, server features | — |

Three HTML5 games (Blocks, Snake, Pong) ship in `static/games/` as a working example of the Vapor launch path.

### Embed slots

Every embedded surface is created with `createFrame()` from `static/js/core/frame.js`. Each one carries a `data-slot` label. When no URL is configured, the slot shows a clearly marked placeholder naming itself:

| Slot | Where the URL comes from |
|---|---|
| `geforcenow.session` | `static/apps.json` → `geforcenow.embed.url`, or the portal URL field in the launcher |
| `youtube.player` | Video ID chosen in the app |
| `spiceify.embed.<id>` | `content/music.json` → `embeds[].url` |
| `player.embed` | `content/movies.json` → `items[].source` with `type: "embed"` |
| `orion.tab.<n>` | Address bar |
| `<app-id>.frame` | `embed.url` of any app using the generic `embed` module |

`createFrame` calls `/api/frame-check` first. If a site forbids embedding (via `X-Frame-Options` or CSP `frame-ancestors`), the slot offers *Load through proxy* or *Open in new tab* instead of showing a blank frame.

## Adding content

All catalogues live in `content/`. They are plain JSON, served by `GET /api/content/<kind>` and re-read on every request, so no restart is needed. Each file has a `_readme` field describing its schema.

```jsonc
// content/movies.json — one title
{ "id": "my-film", "title": "My Film", "year": 2026, "rating": "PG", "duration": "1h 42m",
  "genres": ["Drama"], "description": "…", "poster": "…", "backdrop": "…",
  "source": { "type": "video", "src": "https://cdn.example.com/my-film.mp4" } }
  // or { "type": "hls", "src": ".../master.m3u8" }
  // or { "type": "embed", "src": "https://player.example.com/embed/123" }

// content/games.json — one game
{ "id": "my-game", "title": "My Game", "genres": ["Action"], "cover": "games/covers/my-game.png",
  "launch": { "type": "iframe", "url": "https://games.example.com/my-game/", "size": [1280, 720] } }
  // type: "iframe" | "proxy" | "external"
```

**Wallpapers:** drop any `.mp4`/`.webm`/`.mov` loop into `static/media/wallpapers/` and it appears in Settings automatically. A same-named `.jpg`/`.png`/`.webp` becomes its poster. Alternatively, list it in `content/wallpapers.json`, which also accepts absolute URLs. The default *Aurora Ridge* loop is original and was rendered with `tools/wallpaper/`.

## Adding an app

**URL-only app (no code):** add an entry to `static/apps.json` with `"module": "embed"` and an `embed` descriptor:

```json
{ "id": "my-portal", "name": "My Portal", "module": "embed", "icon": "globe", "category": "Internet",
  "description": "…", "developer": "…", "version": "1.0.0", "default_size": [1200, 760],
  "embed": { "url": "https://portal.example.com/", "allow": "autoplay; fullscreen", "proxy": false } }
```

Users can do the same at runtime with **App Store → Add web app**.

**Custom app:** create `static/js/apps/<module>.js`:

```js
import { createFrame } from '../core/frame.js';
export default {
  single: true,                       // optional: re-focus instead of opening a second window
  mount(body, ctx) {                  // ctx: { win, app, args, api, store, bus, notify, open }
    const frame = createFrame({ slot: 'my-app.main', url: 'https://…', allow: 'fullscreen' });
    body.append(frame.el);
    return { destroy: () => frame.destroy() };   // also: onFocus, onResize, onArgs, beforeClose
  },
};
```

To give an app full-tile icon artwork, add an SVG to `tileArt` in `static/js/core/icons.js`. Otherwise it gets a gradient tile with a glyph.

## The content proxy

`GET /proxy?url=…` fetches a page on the server so it can be shown inside an iframe even when the site sends `X-Frame-Options` or `frame-ancestors`. In the page it returns, the server:

- removes framing headers and any `<meta http-equiv>` policies;
- injects `<base href>`, so images, scripts and stylesheets load directly from the original site;
- injects a small script that routes link clicks and GET form submissions back through the proxy, and reports each navigation and page title to Orion.

### Security model

| Threat | Mitigation |
|---|---|
| SSRF | Only `http`/`https`, and no credentials in the URL. The host is resolved once and **every** returned address must be public: loopback, RFC 1918, link-local/metadata, CGNAT, ULA and IPv4-mapped addresses are all rejected. The connection is then pinned to that validated address, so DNS rebinding doesn't work. Redirects are not followed on the server; each hop comes back through `/proxy` and is checked again. |
| Proxied pages attacking LTF OS | Responses carry `Content-Security-Policy: sandbox …` **without** `allow-same-origin`, and the iframe gets the same sandbox. Proxied pages therefore run in an opaque origin with no access to LTF OS storage, cookies or API responses (verified in the browser: `origin: "null"`, `localStorage` blocked). |
| CSRF against the API | State-changing API calls require an `X-LTF-Client` header. That forces a CORS preflight, and the server sends no CORS headers, so no other origin can pass it. |
| Abuse and cost | Optional host allowlist (`LTF_PROXY_ALLOW`), 20 s timeouts, and size caps of 6 MB for HTML and 32 MB for other resources. The proxy can be turned off entirely with `LTF_PROXY=0`. |

### Limitations (by design)

No cookies are forwarded, so you can't stay signed in to a site through the proxy. Services with DRM, WebRTC streaming or heavy client-side routing — Netflix, Spotify's web player, GeForce NOW — won't work through a proxy.

For those services, use the official embed they provide (YouTube's embed player, Spotify's embed widgets), or open them in a new tab. The app frames offer the new-tab option automatically.

Some sites' terms of service also forbid framing or proxying. Only point the proxy at content you are allowed to present this way.

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
  main.rs            router, CSRF guard, static files (range requests for video), graceful shutdown
  config.rs          environment configuration
  state.rs           prefs, installs, custom web apps, HTTP client, WebSocket broadcast
  catalog.rs         app registry (embeds static/apps.json)
  handlers/
    proxy.rs         /proxy + /api/frame-check (SSRF guard, HTML rewriting, sandbox CSP)
    content.rs       /api/content/{movies,music,games,youtube,wallpapers}
    youtube.rs       /api/youtube/search (Data API v3; key stays on the server)
    apps.rs          /api/apps (install, uninstall, custom web apps)
    files.rs         /api/files (Notepad storage, multipart upload, download)
    prefs.rs         /api/prefs (GET / PUT / PATCH merge-patch / reset)
    system.rs        /api/system/{info,boot-log}, /api/ping
    ws.rs            /ws event stream
content/             creator catalogues (JSON)
static/
  apps.json          app catalogue
  css/system/ …      design tokens + system components
  css/apps/ …        per-app styles
  js/core/           wm, frame, taskbar, startmenu, desktop, dnd, wallpaper, boot, store, api, theme, …
  js/apps/           one module per app (+ embed.js generic container)
  js/lib/            videoplayer (HLS-capable), markdown
  games/             bundled HTML5 games + covers
  media/wallpapers/  live wallpaper loops
tools/wallpaper/     frame-exact WebCodecs renderer for original wallpaper loops
```

## Trademarks

"YouTube" and "GeForce NOW" identify the third-party services those apps embed. The app icons are original artwork in the style of each service. Before a public or commercial deployment, review each provider's brand guidelines and terms of use. Also make sure every title in `content/` is licensed for your use. The bundled samples are Blender Foundation open movies (CC BY) and SoundHelix test tracks.
