# LTF OS

A web desktop operating system with a Windows 11 "rice" look, an Arch Linux–style boot, and a Ninja Low Taper Fade loading spinner. The backend is Rust (Axum). The frontend is vanilla ES modules with no framework and no build step.

## Run it

```bash
cargo run --release
# → http://localhost:8080
```

| Env var          | Default  | Purpose                                  |
|------------------|----------|------------------------------------------|
| `PORT`           | `8080`   | HTTP port                                |
| `LTF_DATA_DIR`   | `data`   | Preferences, installed apps, documents   |
| `LTF_STATIC_DIR` | `static` | Frontend files                           |
| `RUST_LOG`       | `ltf_os=info` | Log filter                          |

`cargo test` runs the backend unit tests: merge-patch semantics, path-traversal rejection and catalog validity.

The frontend also boots without the backend, for example from a static host. Preferences and installs fall back to `localStorage` and the metrics are simulated.

## Features

- **Boot:** a systemd/Arch log (`[  OK  ] Reached target …`), streamed from `/api/system/boot-log`. A spinning Ninja LTF sits in the corner with a progress bar, then it crossfades into the desktop. Press `Esc` to skip. Settings → System → *Fast boot* turns the animation off.
  - To use the real meme, drop it in as `static/assets/ninja-ltf.png`. Otherwise the bundled SVG mascot is used.
- **Look:** Acrylic/Mica glass (`backdrop-filter`), dark and light modes, 10 accent presets or any custom colour, and a transparency toggle.
- **Live wallpaper (Canvas):** three modes: *particle network* (reacts to the cursor), *aurora* and *synthwave*. You can pause the animation from Settings, the desktop menu, or Quick settings → Battery saver. It also pauses automatically when the tab is hidden.
- **Taskbar:**
  - Docks to the **bottom, top, left or right** edge. Change it by right-clicking the taskbar or desktop, or in Settings → Taskbar.
  - Optional centered icons and auto-hide.
  - Running and focused indicators, and a window count when an app has several windows.
  - Hover previews.
  - Quick settings: Wi-Fi, Bluetooth, night light, brightness and volume (scroll over the tray to change volume).
  - Calendar flyout.
- **Drag and drop:**
  - Drag a taskbar app onto the desktop to create a shortcut. The icon snaps to the grid, with a ghost preview.
  - Drag a desktop icon or Start menu app onto the taskbar to pin it at the drop position.
  - Drag desktop icons to rearrange them; dropping on an occupied cell swaps the two.
  - Rubber-band selection, and `Del` removes the selected shortcuts.
- **Windows:**
  - Drag, resize from 8 edges, focus and z-order.
  - Minimize animates into the app's taskbar icon.
  - Maximize or restore; double-clicking the title bar does the same.
  - Snap by dragging to the top edge (maximize) or the left/right edges (half screen).
  - Title bar context menu.
- **Widgets:** clock (digital or analog; click to switch), performance (live over WebSocket), weather and quick notes. You can drag them anywhere, and their positions persist on the server.
- **Keyboard shortcuts:**
  - `Ctrl+Space`: Start
  - `Alt+W`: close window
  - `Alt+M`: minimize
  - `Alt+↑`: maximize
  - `Alt+D`: show desktop
  - `Ctrl+Alt+T`: terminal
  - `Ctrl+Alt+L`: lock

### Apps

| App | Module | Highlights |
|-----|--------|-----------|
| **App Store** | `appstore.js` | Browse by category, search, install (with a progress bar), uninstall, open. |
| **Cinema** (movies) | `movies.js` | Custom video controls: seek with hover time, buffered bar, speed, PiP, fullscreen, keyboard shortcuts. Playlist with posters, plus local file playback. |
| **Groove** (music) | `music.js` | Tracks are **synthesized live with WebAudio**, so no audio files are needed. Play/pause, seek, shuffle, repeat (all/one/off), volume. Generated album art and a canvas visualizer with three modes (bars, radial, wave). |
| **Arcade** (games) | `games.js` | Neon Snake, Fade Blocks (Tetris-style) and Taper Pong, with saved high scores. |
| **Notepad** | `notepad.js` | Text/Markdown editor with live preview. Save and open through the Rust `/api/files` endpoints, upload (multipart) and download (`Content-Disposition`). Local draft autosave, `Ctrl+S`. |
| **FadeNOW** (cloud gaming) | `cloudgaming.js` | GeForce NOW–style portal: hero banner, game cards by tier, a live latency widget, region/server picker with ping and load, and quality presets. A queue leads into a stream view with an embedded game and a stats HUD. |
| Files | `explorer.js` | Browse, open, upload (drag and drop), download and delete documents. |
| Settings | `settings.js` | Personalization, taskbar, widgets, sound, system info, reset. |
| Terminal | `terminal.js` | `neofetch`, `ls`, `cat`, `echo > file`, `pacman -S <app>`, `theme #hex`, `taskbar left`, and more. |
| Task Manager | `taskmgr.js` | Live CPU/RAM/GPU/network graphs, per-core load, "End task". |
| Calculator, Sketch | `calculator.js`, `paint.js` | Available to install from the App Store. |

## Architecture

```
src/
  main.rs            router, static serving, compression, graceful shutdown
  state.rs           AppState: prefs (JSON), installed apps, simulated metrics, WS broadcast bus
  catalog.rs         App Registry: embeds static/apps.json (single source of truth)
  error.rs           ApiError → JSON error responses
  handlers/
    system.rs        /api/system/{info,stats,boot-log}, /api/weather
    prefs.rs         GET/PUT/PATCH (RFC 7396 merge-patch) /api/prefs, POST /api/prefs/reset
    apps.rs          GET /api/apps, POST /api/apps/{id}/install, DELETE /api/apps/{id}
    files.rs         /api/files list/read/write/delete, /upload (multipart), /{name}/download
    media.rs         /api/media/{tracks,videos}, /api/cloud/{games,servers,session}
    ws.rs            /ws event stream (metrics every second, prefs/app/file events)
static/
  index.html         shell markup (boot screen, desktop, taskbar, flyouts)
  apps.json          app catalogue, shared by the backend and the offline frontend
  css/styles.css     shell styles; every token is a CSS custom property
  css/apps.css       app styles
  js/app.js          entry: boot → load prefs/registry → init shell
  js/core/           wm, taskbar, startmenu, desktop, dnd, widgets, wallpaper, boot, store, api, …
  js/lib/            synth (WebAudio engine), games (canvas games), markdown
  js/apps/           one ES module per app
```

### Adding an app

1. Add an entry to `static/apps.json` (`id`, `name`, `module`, `icon`, `category`, …).
2. Create `static/js/apps/<module>.js`:

```js
export default {
  single: true,              // optional: focus the existing window instead of opening another
  mount(body, ctx) {         // ctx: { win, args, api, store, bus, notify, open }
    body.textContent = 'Hello from my app';
    return () => {};         // cleanup, or { destroy, onFocus, onResize, onArgs, beforeClose }
  },
};
```

3. Optionally, add a tile gradient in `js/core/icons.js` (`tileColors`).

### Ricing

All colours, blur, radii, spacing, fonts and timing live in `:root` in `static/css/styles.css`, e.g. `--accent`, `--blur`, `--radius-lg`, `--tb-size`, `--ease`. Settings writes `--accent` and a derived `--accent-2` at runtime.
