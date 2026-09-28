# Orion OS — private beta deployment

This guide runs Orion OS as a private HTTPS website that you can open from any of your devices. The Git repository stays private: you deploy a build, not the source repository.

```text
Browser (any device)
   │  HTTPS (HTTP/2) + WSS            https://YOUR_DOMAIN
   ▼
Reverse proxy — Caddy or nginx        TLS certificates, HTTP→HTTPS, HSTS,
   │                                  unknown hostnames refused
   │  HTTP/1.1 + WebSocket upgrade, Host and Origin passed through unchanged
   ▼
Orion OS (ltf-os) on 127.0.0.1:8080   Host allowlist → access gate → API / /ws / web layer / shell
   │
   ▼
LTF_DATA_DIR (/var/lib/orion-os)      prefs, installed apps, web apps, Notepad files
```

Orion OS does not handle TLS itself. A standard reverse proxy does, and Orion OS listens on loopback only.

The reference configurations in [`deploy/`](../deploy) are tested. `tests/browser/deploy.browser.mjs` runs the nginx file, or the Caddyfile with `ORION_PROXY=caddy`, against a real server in Chromium. Only the domain, ports and certificate paths are substituted.

## 1. Prerequisites

- **A server you control.** Any Linux host, VM or home server works. No cloud provider is assumed.
- **A hostname for it.**
  - A public DNS name (`YOUR_DOMAIN → YOUR_SERVER`) lets Caddy or Let's Encrypt issue a certificate automatically.
  - A private-network name, such as a VPN or tailnet name, needs a certificate from wherever that network provides one.
- **Open ports.** Allow 443/tcp, and 80/tcp for certificate issuance and the HTTP→HTTPS redirect. Port 8080 must **not** be reachable from outside.
- **Tools.** Rust (stable) to build, and Caddy ≥ 2.6 or nginx ≥ 1.19.4 (`ssl_reject_handshake`).

## 2. Build

```bash
cargo build --release          # → target/release/ltf-os
cargo test                     # backend tests, including the beta access and Host tests
```

The following need to be copied to the server. The binary is still named `ltf-os`, a compatibility identifier (see the README "Naming" note).

| Copy | To | Notes |
|---|---|---|
| `target/release/ltf-os` | `/opt/orion-os/ltf-os` | |
| `static/` | `/opt/orion-os/static` | |
| `content/` | `/opt/orion-os/content` | |
| `apps.json` | — | Compiled into the binary; nothing to copy. |

There are no source maps or dev bundles. The frontend is served as authored.

## 3. Configure the environment

Start from [`deploy/orion-os.env.example`](../deploy/orion-os.env.example). Install it as `/etc/orion-os/orion-os.env`, mode `0600`, owned by root.

| Variable | Beta value | Meaning |
|---|---|---|
| `LTF_MODE` | `beta` | Turns on the private-beta safeguards below. Default `development`. |
| `LTF_BIND` | `127.0.0.1` | Listen address. Beta default `127.0.0.1`; development default `0.0.0.0` (unchanged). |
| `PORT` | `8080` | HTTP port behind the proxy. |
| `LTF_ALLOWED_HOSTS` | `YOUR_DOMAIN` | Exact hostnames trusted in `Host` (comma-separated). Required in beta. |
| `LTF_ACCESS_KEY_FILE` | *(path)* | File whose first line is the access key. Use this rather than `LTF_ACCESS_KEY`. |
| `LTF_ACCESS_KEY` | — | The key itself. Only for quick tests, because environment variables are easier to leak. |
| `LTF_SESSION_HOURS` | `168` | How long a sign-in lasts, from 1 to 720 hours. |
| `LTF_DATA_DIR` | `/var/lib/orion-os` | Server-side state (§10). |
| `LTF_STATIC_DIR`, `LTF_CONTENT_DIR` | `/opt/orion-os/…` | Frontend files and content catalogues. |
| `LTF_TRUST_PROXY_HEADERS` | `1` | Rate limits and sign-in throttling use `X-Forwarded-For`. The reference proxy configs overwrite it, so clients can't spoof it. |
| `LTF_NETCHECK_URL` | *(default)* | Fixed destination for the Network widget's probe; empty disables it. |
| `YOUTUBE_API_KEY` | optional | Enables YouTube search. |

All other existing variables (`LTF_PROXY`, `LTF_PROXY_ALLOW`, `LTF_RATE_LIMIT`, `LTF_USE_ENV_PROXY`, `RUST_LOG`) behave as described in the README.

In beta mode Orion OS **refuses to start** in any of these cases. It prints the reason, but never the key.

- No access key is configured.
- The key is shorter than 16 characters.
- `LTF_ALLOWED_HOSTS` has no valid hostname.
- `LTF_PROXY_ALLOW_PRIVATE` is set.
- `LTF_MODE`, `LTF_BIND` or `LTF_SESSION_HOURS` has an invalid value.

Generate the key once and keep it in a password manager:

```bash
sudo install -d -m 0700 /etc/orion-os
openssl rand -base64 32 | sudo tee /etc/orion-os/access-key >/dev/null
sudo chmod 0600 /etc/orion-os/access-key
```

## 4. Trusted hosts

`LTF_ALLOWED_HOSTS` uses the Step 21 host model unchanged.

- **Always trusted:** `localhost` and IP literals.
- **Trusted when listed:** the names you list, matched **exactly**, in any letter case and on any port.
- **Rejected:**
  - wildcards and suffix matches;
  - `*.localhost` names;
  - look-alikes such as `YOUR_DOMAIN.evil.example`;
  - malformed values;
  - an HTTP/2 authority that disagrees with `Host`.

List every name you type in the browser, for example `beta.example.com,orion.my-tailnet.ts.net`. Invalid entries are dropped with a warning; they never widen trust.

| | Development | Private beta |
|---|---|---|
| URL | `http://localhost:8080`, `http://127.0.0.1:8080`, `http://192.168.1.20:8080` | `https://YOUR_DOMAIN` |
| `LTF_MODE` | `development` (default) | `beta` |
| Bind | `0.0.0.0` | `127.0.0.1` (behind the proxy) |
| Access key | Optional | Required |
| Cookie | `orion_session` (no `Secure`, since plain http) | `__Host-orion_session` (`Secure`) |
| `/ws` and sign-in `Origin` | Must equal `http(s)://<Host>` | Must equal `https://<Host>` |

## 5. Start the server

With systemd, use [`deploy/orion-os.service`](../deploy/orion-os.service).

- It runs as the unprivileged `orion-os` user.
- It hands the access key over with `LoadCredential`.
- It sets `UMask=0077` and restricts writes to the data directory.

```bash
sudo useradd --system --home /var/lib/orion-os --shell /usr/sbin/nologin orion-os
sudo cp deploy/orion-os.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now orion-os
journalctl -u orion-os -f        # "configuration loaded" … "listening on http://127.0.0.1:8080"
```

Any other supervisor works as well. Load the environment file and run `/opt/orion-os/ltf-os` as a dedicated user.

## 6. Reverse proxy

**Caddy (simplest):** [`deploy/Caddyfile.example`](../deploy/Caddyfile.example).

- Replace `YOUR_DOMAIN`.
- Caddy fetches and renews the certificate, redirects HTTP to HTTPS and proxies WebSockets.
- It keeps `Host` and replaces untrusted `X-Forwarded-For` with the real client address, all by default.

**nginx:** [`deploy/nginx-orion-os.conf`](../deploy/nginx-orion-os.conf).

- Replace `YOUR_DOMAIN` and the certificate paths, for example from `certbot certonly --webroot`.
- It provides an HTTP→HTTPS redirect.
- A catch-all `default_server` refuses unknown TLS names (`ssl_reject_handshake`), and a Host that doesn't match gets 421.
- It sends HSTS and sets `server_tokens off`.

Any other HTTPS reverse proxy works if it meets the contract below.

| Requirement | Why |
|---|---|
| Terminates TLS and serves only HTTPS to browsers | The session cookie is `Secure` and `__Host-`. |
| Forwards the original `Host`, including a non-default port (nginx: `$http_host`) | `Host` must be in `LTF_ALLOWED_HOSTS`, and `/ws` needs `Origin == https://<Host>`. |
| Leaves `Origin` and `Cookie` untouched | Origin and session checks. |
| Passes WebSocket upgrades on `/ws` (`Upgrade`, `Connection: upgrade`, HTTP/1.1 upstream) with a long read timeout | The desktop event stream. |
| Overwrites `X-Forwarded-For` with the client address | Per-client throttling when `LTF_TRUST_PROXY_HEADERS=1`. |
| Doesn't cache responses | API responses are live; sign-in responses are `no-store`. |

## 7. HTTPS

HTTPS is **required** in beta mode.

- Browsers only store the `__Host-`/`Secure` session cookie over HTTPS.
- The service worker only registers in a secure context.

Keep HSTS on once the certificate works; the reference configs send `max-age=31536000`. Don't expose port 8080. It is bound to loopback, but also block it at the firewall.

## 8. WebSocket (`/ws`)

The desktop opens `wss://YOUR_DOMAIN/ws` on the same origin (`static/js/core/api.js`). The server accepts the upgrade only when all of these hold:

1. `Host` is trusted (§4).
2. The request carries a valid session cookie (§9). Otherwise it gets 401.
3. `Origin` is exactly `https://<Host>`; in development, `http(s)://<Host>`. Foreign, `null`, missing, look-alike and `http://` origins get 403 before the upgrade.

While connected, the socket re-checks its session every 15 s and closes once the session expires or signs out. Messages are unchanged: the `hello` greeting, `{"type":"ping"}` → `{"type":"pong"}`, and server events. They never contain credentials.

If `/ws` fails:

- **403:** the proxy changed `Host` (for example `proxy_set_header Host $host` dropping a port) or `Origin`.
- **401:** the cookie didn't reach the backend.
- **Connection closes after about 60 s:** raise the proxy read timeout.

## 9. Private access

Anyone who knows the **access key** can use this Orion OS; nobody else can. There are no accounts, profiles, social logins or tenants.

- **Signed out:**
  - Every route except `/login`, `/logout` and `/healthz` answers **401**, including the static shell, `/api/*`, the web layer (`/api/web/inspect`, `/proxy/*`, `/net/*`) and `/ws`.
  - A browser navigation gets a self-contained sign-in page. It has no scripts, can't be framed and is never cached.
  - Everything else gets `{"error":{"code":"UNAUTHENTICATED"}}`.
  - It is never a redirect, so the service worker can't cache the sign-in page as the desktop.
- **Sign-in:**
  - The key is sent in a form POST body to `/login`, never in a URL.
  - It is compared in constant time.
  - The POST must come from the same origin.
  - Attempts are throttled to 10 per minute per client and 60 per minute overall.
  - Success sets `__Host-orion_session=…; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=…`.
- **Session token:**
  - Its format is `v1.<expiry>.<random nonce>.<HMAC-SHA256>`, with the HMAC keyed from the access key.
  - Sessions survive restarts.
  - **Changing the key signs every device out.**
- **Sign-out** (Settings → System → Sign out, or `POST /logout`):
  - It revokes that session for the rest of the process's life and expires the cookie.
  - Local browser data (§10) is kept.
- **CSRF:** unchanged. State-changing API calls still need `X-LTF-Client`, and `SameSite=Lax` keeps the cookie off cross-site subresource requests.
- **Where the key never appears:** URLs, logs (even at debug level), responses, frontend source, app manifests, WebSocket messages, or `Debug` output of the configuration.

To revoke all access, change the key file and restart.

## 10. Data: browser vs server

Nothing was migrated. Each piece of data stays where it lived before.

| Where | What |
|---|---|
| **Orion OS server** (`LTF_DATA_DIR`) | <ul><li>`prefs.json`: theme, taskbar, desktop layout, boot options, synced from Settings.</li><li>`installed.json`: installed apps.</li><li>`custom_apps.json`: web apps added in the App Store.</li><li>`files/`: the Notepad drive.</li></ul> |
| **Browser** (localStorage, per device) | <ul><li>`ltf:prefs`: offline mirror of the preferences.</li><li>`ltf:user-apps`: user-created local apps.</li><li>`ltf:appdata:<app>:<key>`: `ltf.storage` for apps.</li><li>App state: Notepad draft, Orion bookmarks and mode, Spiceify, YouTube history, Vapor library, GeForce NOW URL, volume and mute.</li><li>Service worker caches: shell and `/net/` images.</li></ul> |
| **Nowhere** | Window positions and sizes, which last only for the page session (as before). |

The server-side data is shared by everyone who signs in. Browser data belongs to one browser on one device.

Back up `LTF_DATA_DIR`. It should be `0700` and owned by the service user; the systemd unit's `StateDirectoryMode=0700` and `UMask=0077` do this.

## 11. Health and smoke testing

```bash
curl -fsS https://YOUR_DOMAIN/healthz                        # → ok  (no session needed; reveals nothing else)
curl -s -o /dev/null -w '%{http_code}\n' https://YOUR_DOMAIN/api/ping      # → 401 (gate is on)
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: evil.example' https://YOUR_DOMAIN/   # → 421/403, never 200 from Orion OS
```

Then run the manual checklist in [private-beta-checklist.md](private-beta-checklist.md) from a browser that is not your development browser.

The automated equivalent (needs nginx or Caddy, openssl and Playwright) builds the full stack locally:

```bash
cargo build && node tests/browser/deploy.browser.mjs          # nginx
ORION_PROXY=caddy node tests/browser/deploy.browser.mjs       # Caddy
```

## 12. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Server exits with `refusing to start: …` | Read the message: missing or short key, missing `LTF_ALLOWED_HOSTS`, or an invalid value. |
| `403 unrecognized host` | The name you typed isn't in `LTF_ALLOWED_HOSTS`, or the proxy rewrote `Host`. |
| Sign-in page again after submitting the right key | You're on `http://` (the `Secure` cookie is dropped), or the proxy strips `Set-Cookie`/`Cookie`. |
| `cross-origin sign-in refused` | The proxy rewrote `Host` or `Origin`, or you used a different hostname than the one you loaded. |
| Desktop loads but shows "server unreachable" / the widgets stay offline | `/ws` isn't upgraded (§8) or the session expired. Reload to sign in. |
| `Too many attempts` | Wait a minute. With `LTF_TRUST_PROXY_HEADERS=0` behind a proxy, all clients share one throttle bucket. |
| Everyone got signed out | The access key changed, or `LTF_SESSION_HOURS` elapsed. |
| A site won't open in a window | Expected when it forbids embedding (X-Frame-Options/CSP). Use **Open in browser tab**. Orion OS never bypasses framing, DRM, logins, paywalls or bot checks. |

## Production safety review (this deployment)

- **Host:** exact allowlist, checked outermost, before the access gate. HTTP/2 authority and `Host` must agree. No wildcards, no `*.localhost`.
- **Origin / WebSocket:** same-origin only (`https://` in beta), plus a session. Open sockets close when their session ends.
- **Authentication:**
  - one access key, compared in constant time and throttled;
  - `__Host-` + `Secure` + `HttpOnly` + `SameSite=Lax` cookie with an HMAC-signed expiry;
  - server-side revocation on sign-out.
- **Errors:** fixed messages. Internal errors return `Internal server error`, and the detail goes to the server log only. Sign-in failures never echo input.
- **Logs:** sign-in success, failure and throttling are logged with the client IP, never the key. `RUST_LOG` defaults to `info`.
- **Exposed ports:** only the proxy's 80/443. Orion OS binds loopback in beta.
- **Filesystem:** dedicated user, data directory `0700`, key file `0600` passed as a systemd credential.
- **Public endpoints:** `/healthz` returns `ok` and nothing else. There are no other unauthenticated routes. `window.__ltfBridge` is a read-only counter hook inside the signed-in shell (used by tests).
- **Headers:**
  - no `Server` version from Orion OS; the proxy configs hide theirs;
  - HSTS from the proxy;
  - the sign-in page sends CSP `default-src 'none'`, `frame-ancestors 'none'` and `X-Frame-Options: DENY`.
- **CORS:** none. No `Access-Control-*` headers are sent, so other origins can't read responses.
- **Service worker:** unchanged. It never touches `/api`, `/proxy` or `/ws`. Signed-out responses are 401s, which it doesn't cache.

**Known limits:**

- Revocations are in memory, so after a restart a signed-out token is valid again until it expires. Rotate the key to revoke everything.
- One key means one trust level. Anyone with it can use the full desktop and the shared server-side data.
- The web layer (`/proxy`, `/net`) fetches public sites from your server's IP for signed-in users. Keep `LTF_PROXY_ALLOW` narrow or set `LTF_PROXY=0` if you don't use isolated mode.
