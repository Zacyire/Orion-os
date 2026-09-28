# Deploying Orion OS

Orion OS runs as a normal website, `https://orion.YOUR_DOMAIN`, on a server you rent. The GitHub repository stays private and has nothing to do with the live site. GitHub Pages is not used, because it can only serve static files and Orion OS needs its Rust server.

New to servers? Follow **[How I put Orion OS online](put-orion-online.md)** step by step. This page is the reference behind it.

```text
GitHub (private repo) ──git pull (read-only deploy key)──▶ your server
                                                           │  deploy/update.sh: cargo build --release → /opt/orion-os
Browser (home, phone, school PC)                           ▼
   │ HTTPS + WSS  https://orion.YOUR_DOMAIN      ┌──────────────────────────────────┐
   └────────────────────────────────────────────▶│ Caddy (or nginx) :443 / :80       │ certificates, HTTP→HTTPS, HSTS
                                                 │   ▼ HTTP/1.1 + WebSocket upgrade  │
                                                 │ Orion OS 127.0.0.1:8080 (systemd) │ Host check → access key → app
                                                 │   ▼                               │
                                                 │ /var/lib/orion-os  (your data)    │ backed up by deploy/backup.sh
                                                 └──────────────────────────────────┘
```

## What you need to get yourself

| Piece | What | Typical cost |
|---|---|---|
| **A server** | Any VPS provider (for example Hetzner, DigitalOcean, OVH or Linode). Ubuntu 24.04 LTS, 1 vCPU, **2 GB RAM** (or 1 GB plus swap, see §3), 20 GB disk, a public IPv4 address. | about $5–12 per month |
| **A domain name** | From any registrar. You'll use a subdomain such as `orion.example.com`. | about $10–15 per year |
| **HTTPS certificate** | Nothing to buy. Caddy gets a free Let's Encrypt certificate automatically. | free |
| **Repository access from the server** | A read-only **deploy key**: GitHub repo → Settings → Deploy keys. The repo stays private. | free |

Everything else (Rust, Caddy, the firewall) is free software installed on the server.

## 1. Why this setup

- **A plain VPS with systemd and Caddy** is the most conventional setup that meets every requirement: HTTPS, WebSockets, `/api`, and persistent files on disk. There's no container platform, serverless layer or vendor-specific service to learn.
- **Caddy is recommended over nginx.** It handles certificates, HTTP→HTTPS redirects and WebSockets with a 10-line config. [`deploy/nginx-orion-os.conf`](../deploy/nginx-orion-os.conf) is the tested alternative.
- **Orion OS listens only on `127.0.0.1:8080`.** The internet reaches it only through Caddy.

## 2. Configuration (`/etc/orion-os/orion-os.env`)

Copy [`deploy/orion-os.env.example`](../deploy/orion-os.env.example) and change `orion.YOUR_DOMAIN`. The file contains no secrets.

| Variable | Production value | Meaning |
|---|---|---|
| `LTF_MODE` | `production` | Turns on the safeguards below. `beta` (the old name) still works. The default is `development`. |
| `LTF_BIND` | `127.0.0.1` | Listen address. The production default is `127.0.0.1`; don't change it. |
| `PORT` | `8080` | Port behind Caddy. |
| `LTF_ALLOWED_HOSTS` | `orion.YOUR_DOMAIN` | The hostname you type in the browser. Exact match only; comma-separate several names. Required. |
| `LTF_ACCESS_KEY_FILE` | *(set by systemd)* | File holding the access key. The unit passes `/etc/orion-os/access-key` through `LoadCredential`. |
| `LTF_SESSION_HOURS` | `168` | Lifetime of "Keep me signed in", from 1 to 720 hours. Without it, a sign-in ends when the browser closes, or after 12 hours at most. |
| `LTF_DATA_DIR` | `/var/lib/orion-os` | Your data. Back this up. |
| `LTF_STATIC_DIR`, `LTF_CONTENT_DIR` | `/opt/orion-os/static`, `/opt/orion-os/content` | Installed by `deploy/update.sh`. |
| `LTF_TRUST_PROXY_HEADERS` | `1` | Use the client address that Caddy or nginx passes on, for rate limiting. |
| `LTF_PROXY` | `0` | Server-side fetching of other websites is **off** (§8). |
| `LTF_NETCHECK_URL` | *(default)* | Fixed target for the Network widget's latency check. |
| `YOUTUBE_API_KEY` | optional | YouTube search. It's a secret, so keep the env file `0600`. |
| `RUST_LOG` | `ltf_os=info,tower_http=warn` | Log detail. |

**The access key** is the one password for the site. It lives in its own root-only file, never in the repository, the env file, a URL or the frontend:

```bash
openssl rand -hex 16 | sudo tee /etc/orion-os/access-key >/dev/null   # 32 characters
sudo chmod 0600 /etc/orion-os/access-key
sudo cat /etc/orion-os/access-key        # copy it into your password manager
```

A long passphrase of five or six random words also works (minimum 16 characters). It's easier to type on a school computer.

Production mode **refuses to start** in any of these cases. The log says why, but never prints the key.

- There is no access key, or it is shorter than 16 characters.
- `LTF_ALLOWED_HOSTS` has no valid hostname.
- `LTF_PROXY_ALLOW_PRIVATE` is set.
- A value is invalid.

## 3. Build and install

The server builds from your private clone. For first-time setup, see the beginner guide.

```bash
./deploy/update.sh            # git pull → cargo build --release → install to /opt/orion-os → restart → health check
./deploy/update.sh --test     # the same, running the backend tests first
./deploy/update.sh --no-pull  # build whatever is checked out (used for rollbacks)
```

- **What `update.sh` touches:** the program, `static/` and `content/`.
- **What it never touches:** `/var/lib/orion-os` or `/etc/orion-os`.
- **Rollback copy:** it keeps the old binary as `/opt/orion-os/ltf-os.previous`.
- **Rolling back:** `git checkout <older-commit> && ./deploy/update.sh --no-pull`, then `git checkout main` later.
- **Small servers:** the optimised build needs about 2 GB of memory. On a 1 GB server, add swap once:

  ```bash
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
  ```

The binary is named `ltf-os`, the internal name; see the README "Naming" note. Building on your own computer and copying `target/release/ltf-os`, `static/` and `content/` to `/opt/orion-os/` also works, if that computer runs the same OS and architecture.

## 4. Service (systemd)

[`deploy/orion-os.service`](../deploy/orion-os.service) sets the service up as follows:

- It runs Orion OS as the unprivileged `orion-os` user.
- It restarts it if it crashes.
- It gives it write access to `/var/lib/orion-os` only, created `0700` with `UMask=0077`.
- It passes the access key as a systemd credential.

```bash
sudo systemctl status orion-os         # running?
journalctl -u orion-os -n 50           # recent logs
sudo systemctl restart orion-os        # after editing /etc/orion-os/orion-os.env
```

## 5. HTTPS and the reverse proxy

**Caddy:** copy [`deploy/Caddyfile.example`](../deploy/Caddyfile.example) to `/etc/caddy/Caddyfile`, set your hostname, then run `sudo systemctl reload caddy`.

Caddy gets the certificate on the first request. That only works once **DNS points at the server and ports 80 and 443 are open**.

**nginx:** use [`deploy/nginx-orion-os.conf`](../deploy/nginx-orion-os.conf) with a certificate from certbot.

If you use a different proxy, it must do all of the following:
- serve HTTPS only;
- pass the original `Host` (including the port if the URL has one), `Origin` and `Cookie` unchanged;
- pass WebSocket upgrades on `/ws` with a long read timeout;
- **overwrite** `X-Forwarded-For`;
- not cache responses.

## 6. DNS

At your domain registrar's DNS settings:

| Type | Name | Value |
|---|---|---|
| `A` | `orion` | your server's IPv4 address |
| `AAAA` | `orion` | your server's IPv6 address (only if it has one) |

Wait until `dig +short orion.YOUR_DOMAIN` (or an online DNS checker) shows the address, then reload Caddy.

## 7. Firewall

Open only SSH, HTTP and HTTPS. Port 8080 is never opened: Orion OS listens on loopback, and the firewall is a second layer.

```bash
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw enable && sudo ufw status
```

If your VPS provider has its own cloud firewall, allow the same three ports there. Log in to SSH with keys, not passwords, and turn on automatic security updates (`sudo apt install unattended-upgrades`).

## 8. Access, sessions and shared computers

The site is reachable by anyone who knows the URL, but **only people with the access key can use it**. Everything except the sign-in page and `/healthz` returns 401 until you sign in: the desktop, `/api/*`, `/ws` and the web layer.

There are no accounts, and the design is otherwise unchanged. See [`src/auth.rs`](../src/auth.rs) for the mechanism: an HMAC-signed `__Host-` cookie that is `Secure`, `HttpOnly` and `SameSite=Lax`, a constant-time key check, rate limiting and a same-origin check.

For school and other shared computers:
- **Sign-ins last only for the browser session by default.** Closing the browser signs you out, and the sign-in expires after 12 hours at the latest.
- **Tick "Keep me signed in" only on your own devices.**
- **Settings → System → Erase & sign out** also deletes Orion OS's data stored in *that browser*: drafts, bookmarks, history, app data and caches. Your server files are kept.
- **Don't let a shared browser save the access key.**

**`LTF_PROXY=0`.** Orion OS can fetch and display other websites *through your server*: the Orion browser's "isolated" mode, plus thumbnails and favicons through `/net`.
- With it on, anyone signed in could load sites the local network (for example a school's) is set up to block, so it is **off** in production.
- App windows still open sites directly in the browser, under that network's normal rules. Thumbnails and favicons show a placeholder, and isolated mode is unavailable.
- If a network blocks Orion OS itself, that's the network owner's decision. Don't try to work around it.

## 9. Your data: server vs browser

| Stored on the **server** (`/var/lib/orion-os`, backed up) | Stored in **each browser** (not on the server) |
|---|---|
| `prefs.json`: theme, taskbar, desktop layout | `ltf:prefs`: offline copy of the preferences |
| `installed.json`: installed apps | `ltf:user-apps`: apps you created locally |
| `custom_apps.json`: web apps added in the App Store | `ltf:appdata:*`: data apps keep through `ltf.storage` |
| `files/`: the Notepad drive | Notepad draft, Orion bookmarks, YouTube history, Spiceify, Vapor library, volume; service worker caches |

Window positions aren't saved anywhere. They last for one page session, as before.

## 10. Backups

```bash
sudo ./deploy/backup.sh     # → /var/backups/orion-os/orion-data-<time>.tar.gz (root-only; keeps the newest 14)
```

Run it daily, for example with `sudo crontab -e` and this line:

```
15 3 * * * /home/YOUR_USER/orion-os/deploy/backup.sh >/dev/null
```

**Copy backups off the server** regularly, for example to your own computer:

```bash
scp YOUR_USER@YOUR_SERVER:/var/backups/orion-os/orion-data-*.tar.gz ./orion-backups/
```

(They're root-only on the server. `sudo cp` one to your home directory and `chown` it first, or use your VPS provider's snapshot feature.)

To restore, follow the steps at the top of [`deploy/backup.sh`](../deploy/backup.sh): stop the service, extract, fix the owner, then start it.

The access key isn't part of the backup. It's in your password manager, and you can always make a new one.

## 11. Checking it works

```bash
curl -fsS https://orion.YOUR_DOMAIN/healthz                                        # ok
curl -s -o /dev/null -w '%{http_code}\n' https://orion.YOUR_DOMAIN/api/ping          # 401 (locked until sign-in)
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: evil.example' https://orion.YOUR_DOMAIN/   # not 200 from Orion OS
```

Then go through [deployment-checklist.md](deployment-checklist.md) from another device.

`tests/browser/deploy.browser.mjs` tests this whole setup locally before deploying:
- it uses the same env file, Caddyfile and nginx config;
- it runs over real TLS, HTTP/2 and WSS in Chromium;
- `ORION_PROXY=caddy` switches it to Caddy.

## 12. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Browser: "can't reach this site" | DNS not pointing at the server yet, or the firewall blocking 80/443 | `dig +short orion.YOUR_DOMAIN`; `sudo ufw status`; check the provider's cloud firewall |
| Certificate warning, or `journalctl -u caddy` shows ACME errors | Caddy couldn't prove the domain: DNS wrong, or port 80 closed | Fix DNS and firewall, then `sudo systemctl reload caddy` |
| `502 Bad Gateway` | Orion OS isn't running | `sudo systemctl status orion-os`; `journalctl -u orion-os -n 50` |
| Service exits with `refusing to start: …` | Config problem | The message names it: key missing or short, `LTF_ALLOWED_HOSTS` empty, invalid value |
| `403 unrecognized host` | The hostname you used isn't in `LTF_ALLOWED_HOSTS`, or the proxy rewrote `Host` | Add the exact name and restart; don't change the proxy's Host handling |
| Sign-in page again right after signing in | Using `http://`, or the proxy strips cookies | Always use `https://`; use the provided proxy configs |
| `cross-origin sign-in refused` | Page loaded from one hostname, form posted to another, or the proxy rewrote `Origin`/`Host` | Use one hostname consistently |
| Desktop loads but the widgets say *Offline* / *server unreachable* | WebSocket `/ws` not getting through, or the session ended | DevTools → Network → WS: 101 is good. 403 means `Host`/`Origin` were changed by the proxy. 401 means sign in again. Closing after about 60 s means raising the proxy read timeout (the nginx config uses 1 h). |
| `Too many attempts` | 10 wrong keys per minute | Wait a minute |
| Everyone signed out | The access key changed, or sessions expired | Expected |
| A site shows **Open in browser tab** instead of loading in a window | The site forbids embedding | Expected. Orion OS never bypasses framing rules, DRM or logins. |
| Orion OS works at home but not at school | The school network blocks it | That's the school's policy. Ask IT; don't work around it. |

## 13. Security summary

- **Host check:** exact hostnames only, checked first. No wildcards, look-alikes or `*.localhost`. HTTP/2 authority must equal `Host`.
- **`/ws`:**
  - needs a session and an `Origin` of exactly `https://<host>`;
  - open sockets close when their session ends.
- **Access:**
  - one key, compared in constant time;
  - sign-in is a form POST from the same origin, rate limited;
  - hardened cookie; sign-out revokes the session on the server.
- **Secrets:**
  - the key is in a root-only file passed as a systemd credential;
  - it never appears in the repo, env file, URLs, logs (tested at debug level), responses, frontend or WebSocket messages.
- **Exposure:** only 22, 80 and 443 are open. Orion OS binds loopback and runs as an unprivileged user; its data directory is `0700`.
- **Errors:** generic messages. Internal details go to the log only.
- **CORS:** none. **Health endpoint:** `/healthz` returns only `ok`.

**Known limits:**
- One key means one trust level. Anyone with it shares the same server-side files and settings.
- Signed-out sessions are remembered in memory. After a restart, a copied old cookie could work until it expires. Change the key to sign out everyone.
