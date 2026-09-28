# Orion OS private beta — real-device checklist

Run this from a browser that is **not** your development browser. Ideally that's another device, such as a phone, tablet or second computer, on another network. Use `https://YOUR_DOMAIN`.

Mark each item ✅ or ❌ and note the browser and device.

`tests/browser/deploy.browser.mjs` automates most of this list locally through real nginx or Caddy over HTTPS. This checklist covers what only a real domain, certificate and device can prove.

## Access

- [ ] `http://YOUR_DOMAIN` redirects to `https://`, and the certificate is valid with no warnings.
- [ ] A fresh browser gets the **Sign in · Orion OS** page, not the desktop.
- [ ] A wrong key shows "That access key isn't right", and the page stays signed out.
- [ ] The right key opens the desktop.
- [ ] Reloading keeps you signed in.
- [ ] A private/incognito window on the same device must sign in again.
- [ ] Settings → System → **Sign out** returns to the sign-in page.
- [ ] Signing in again shows your local data (Notepad draft, bookmarks) still there.
- [ ] DevTools → Application → Cookies shows only `__Host-orion_session`, marked HttpOnly, Secure and SameSite=Lax.
- [ ] The key does not appear in the address bar or in history.

## Desktop

- [ ] Boot console → desktop renders, and the wallpaper plays or shows its poster.
- [ ] Windows open from the Start menu, the taskbar and desktop icons.
- [ ] A window moves by dragging its title bar, including by touch on a tablet.
- [ ] A window resizes from its edges and corners.
- [ ] Minimize, maximize, restore and close all work, as do double-clicking the title bar and the keyboard shortcuts.

## WebSocket

- [ ] DevTools → Network → WS shows `wss://YOUR_DOMAIN/ws` with status **101**.
- [ ] The first frame received is `{"type":"hello",…}`.
- [ ] In the console, `new WebSocket('wss://'+location.host+'/ws')` → the `hello` frame arrives; sending `{"type":"ping"}` gets `{"type":"pong"}` back.
- [ ] Installing or uninstalling an app on this device updates the Start menu and App Store on a second signed-in device (a live `app-installed`/`app-uninstalled` event). Settings changes reach other devices after a reload.
- [ ] After about 2 minutes idle, the socket is still open.

## Widgets

- [ ] **Clock** shows local time for *this* device's time zone and ticks each minute.
- [ ] **System Monitor** is "Live" with CPU, memory, uptime and platform.
- [ ] **Network** is "Online" with a latency value. That latency is the server's, not this device's.

## Apps

Sites keep their own rules. A site that refuses embedding shows **Open in browser tab**; that is correct, not a bug.

- [ ] **YouTube:** it opens; playback works, or search works when `YOUTUBE_API_KEY` is set.
- [ ] **GeForce NOW:** it opens. It launches in a browser tab if the service refuses embedding, and sign-in happens on NVIDIA's own site.
- [ ] **Orion browser:** it opens a site. Isolated mode renders a public page; a site that forbids framing shows the native error with **Open in browser tab**.
- [ ] **Spiceify:** it opens and plays a track from the catalogue.
- [ ] **Notepad:** save a file, reload, and it's still there. Open the same file on a second device and it matches.
- [ ] **App Store:** it opens and lists apps; install and uninstall work.
- [ ] Nothing asks for or bypasses a third-party login, paywall, DRM or bot check.

## Negative checks (from any machine)

- [ ] `curl -s -o /dev/null -w '%{http_code}' https://YOUR_DOMAIN/api/ping` → `401`
- [ ] `curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example' https://YOUR_DOMAIN/` → not `200` from Orion OS (421 or 403)
- [ ] `curl -s https://YOUR_DOMAIN/healthz` → `ok` and nothing else
- [ ] Port 8080 on `YOUR_SERVER` is closed from outside (`nc -vz YOUR_SERVER 8080` fails).
