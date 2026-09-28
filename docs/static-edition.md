# Static edition (GitHub Pages)

Orion OS runs in two editions from the same `static/` frontend:

| | Full edition | Static edition |
|---|---|---|
| Served by | The Rust server (`LTF_MODE=production` behind Caddy or nginx) | Any static host, e.g. GitHub Pages |
| Sign-in | The access key (server-side) | None. The site is public; there's no server data to protect. |
| Settings and app data | Server, plus a copy in the browser | This browser only (localStorage) |
| System Monitor, Network | Live server data | "Server unavailable" (never invented values) |
| Notepad drive, file sync, WebSocket events | Yes | No |
| Web apps that allow embedding | Checked by the server, then shown in a window | Can't be checked without the server, so they offer **Open in browser tab** |
| External apps (Roblox, CineJoy, Netflix, …) | Open in your browser | Same |
| Vapor local catalogue | `/api/content/games` | `content/games.json`, published with the site |

**How the static edition knows what it is:**
- `tools/build-static.sh` sets `<meta name="orion-edition" content="static">`.
- Given that marker, the frontend never calls `/api`, `/ws`, `/net` or `/proxy`, and it doesn't register the service worker.
- The splash says: "Static edition — Orion server unavailable. Settings are saved in this browser."

## Deploying

`.github/workflows/pages.yml` runs on every push to `main` or `claude/busy-hypatia-bfhego`, and can also be started by hand:

1. `node --check` on every frontend script.
2. `node --test tests/*.test.mjs`: the contract tests and the static-build checks.
3. `./tools/build-static.sh _site`. It copies `static/` and `content/*.json`, marks the edition, and fails if anything server-side or secret-looking is included.
4. Upload `_site` and deploy it to GitHub Pages. Pull requests are built and checked, never deployed.

No secrets are used. Nothing from `src/`, `deploy/`, `data/` or any key file is published.

## One-time setup on GitHub

1. Repository → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. **Private repositories:** GitHub Pages for a private repository needs a paid plan (Pro, Team or Enterprise). **The published site is public** even though the repository stays private (except for Enterprise private Pages).
3. **Deploying from a non-default branch:** the `github-pages` environment may only allow deployments from the default branch. Either merge to `main`, or allow `claude/busy-hypatia-bfhego` under **Settings → Environments → github-pages → Deployment branches**.
4. **Address:** the site will be at `https://zacyire.github.io/LTF-os/` (GitHub lowercases the account name). Everything uses relative paths, so the sub-path works.

## Local preview

```bash
./tools/build-static.sh _site && python3 -m http.server -d _site 8000   # → http://localhost:8000
```
