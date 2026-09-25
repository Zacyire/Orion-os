# Vapor — architecture & threat model

**Status:** Step 20 architecture decision record; the Phase-0 security
prerequisites are implemented (Step 21, §15). Nothing else is implemented yet;
this is the plan the next steps build against. Every claim about the current
system was checked against the code (file:line) and, where it matters for
security, reproduced in a real browser against a throwaway server (evidence in
[Appendix A](#appendix-a--evidence); line numbers are as of Step 20).

**One-line summary.** Vapor becomes a *controlled package system for web
content*: authors ship a `.vapor` ZIP with a small `vapor.json`. The Rust
backend verifies the package and extracts it into `data_dir/vapor/`, then
serves it from an **opaque-origin sandbox** with no access to the shell,
`/api`, or other packages. Each installed title becomes an LTF app entry
launched by a new, non-user-selectable `package` runtime. Its only default
capability is its own `ltf.storage` namespace.

---

## 1. Current state

What Vapor is today:

| Question | Answer (verified) |
|---|---|
| Where it lives | `static/js/apps/vapor.js` (174 lines, native module), `static/css/apps/vapor.css`; bundled games in `static/games/` (`blocks`, `snake`, `pong` + `engine.js`, `runner.js`, `game.css`, `covers/`). |
| Backend behaviour | **None specific to Vapor.** The catalog is `content/games.json`, served by the generic `GET /api/content/{kind}` (`src/handlers/content.rs:15`, re-read on every request). |
| Catalog | `{ featured, items: [{ id, title, developer, released, genres, price, description, controls, cover, launch: { type, url, size } }] }`; `launch.type` ∈ `iframe` \| `isolated` \| `external`. |
| "Install" | **Not real.** "Add to Library" stores the id in `localStorage['ltf:vapor:library']` (`vapor.js:21`). Play time is also kept in `localStorage` (`vapor:stats`). Nothing is downloaded, verified or stored. |
| Launch | `vapor.js:48–63` opens the hidden `webplayer` web-app with `{ url: launch.url, proxy: type==='isolated', title, size, allow: 'autoplay; fullscreen; gamepad' }`, or `window.open` for `external`. |
| How bundled games run | `webplayer` (`static/apps.json`) has no `sandbox` field (passed through at `webapp.js:155`), and `frame.js:158/127` loads a **relative** URL with **no sandbox attribute and no preflight**. So bundled games run **same-origin with the shell and unsandboxed**. |
| What a bundled game can reach | Verified from inside `games/blocks.html`: `parent.ltf.wm` / `parent.ltf.registry` callable; shell `localStorage` readable; `GET /api/files` with `X-LTF-Client` → **200**. That is full shell privilege, acceptable only because these files are first-party repo code. |
| Local storage for HTML apps | Games use `localStorage` directly (`runner.js:9–10`, inside try/catch). The Step-11 `ltf.storage` bridge exists (`appstorage.js`, namespace `ltf:appdata:<appId>:`) but bundled games don't use it. |
| Reusable pieces | `createFrame` (explicit `sandbox` is honoured; relative URLs skip preflight), the runtime seam (`runtimes.js` + handler table, Steps 14–15), the widget/window lifecycle, the `window.ltf` bridge + Step-10 permission ids, per-app storage namespaces, `guard.rs` (SSRF-safe outbound fetching), the `data_dir` convention, the `page.rs` "sandbox via CSP header" technique (`page.rs:40`), `content/` catalogs, Vapor's store/library UI. |

**Conclusion:** the Vapor UI and catalog can evolve, but there is no package,
install, storage or isolation layer. Bundled games show the one model third-party
packages must **never** use: same-origin, unsandboxed.

---

## 2. Proposed architecture

```text
 catalog (content/games.json → later operator-configured remote)
   │  item.package = { version, url, sha256, size }
   ▼
 Vapor UI (frontend: browse, confirm permissions, progress, library, launch)
   │  POST /api/vapor/install { catalog_id }      ← never a URL
   ▼
 Rust backend (all filesystem / network / validation)
   download (guard.rs rules, size cap) → sha256 == catalog → archive validation
   → manifest validation → safe streaming extraction → file index
   → atomic move → data_dir/vapor/installed.json
   │  GET /api/vapor/installed   (records, never paths)
   ▼
 registry (frontend) synthesizes an app entry from an allowlist:
   { id: "vapor:<pkg>", type: "web-app", runtime: "package", module: "webapp", … }
   ▼
 wm.open → webapp.js → RUNTIME_HANDLERS.package → createFrame(sandbox: SANDBOX_PACKAGE)
   ▼
 GET /vapor/pkg/<pkg>/<version>/<path>   (backend; index-resolved, CSP-sandboxed,
   │                                      immutable, CORS *, never /api semantics)
   ▼
 opaque-origin document  ──postMessage──▶  bridge (package-aware): ltf.storage only by default
```

Principles: the backend owns everything security-sensitive; the frontend only
presents. Package-supplied data is **validated input**, never configuration.
The host decides runtime, sandbox, URL, id namespace and permissions.

---

## 3. Package format

### Options compared

| Format | Security | Rust | Author ergonomics | Integrity / export | Verdict |
|---|---|---|---|---|---|
| **ZIP (`.vapor` = zip)** | No link/device types by default (symlinks only via Unix mode bits, which are detectable and rejectable); the central directory lists every entry and size **before** extraction, so limits can be checked up front | `zip` crate: mature; deflate-only feature keeps it small | Any OS can create one; rename `.zip` → `.vapor` | One file to hash; export = the original bytes | **Chosen** |
| tar / tar.gz | Symlinks, hardlinks and device files are first-class, so there is more to reject; no central directory, so a bomb is only found by streaming | `tar` + `flate2` | Fine on Unix, awkward on Windows | One file to hash | Rejected |
| Plain directory | No transport integrity; nothing to hash | trivial | Best for development | No single artifact | **Development/source form only** (what gets packed, and what an install extracts to) |
| Custom container | Unproven | Must be written | Needs tooling | — | Rejected |

A `.vapor` package is a ZIP whose root contains `vapor.json` and the web
content. It is equally the author's project, zipped:

```text
my-game/                 my-game-1.0.0.vapor (zip of the folder contents)
  vapor.json
  index.html
  assets/…
  src/*.js  (ES modules fine)
```

### `vapor.json` — minimal manifest (format version 1)

```json
{
  "vapor": 1,
  "id": "com.example.blocks",
  "name": "Blocks",
  "version": "1.0.0",
  "entry": "index.html"
}
```

**Required**

| Field | Rule |
|---|---|
| `vapor` | Manifest format version; integer `1`. Unknown versions are refused. |
| `id` | Lowercase `[a-z0-9]` segments joined by single `.` or `-`, 3–64 chars, starting and ending alphanumeric (reverse-DNS encouraged). Never contains `/ \ : "` or whitespace. |
| `name` | 1–60 chars after trimming. Display only. |
| `version` | Strict `MAJOR.MINOR.PATCH` (digits only, no pre-release/build in v1), so it is safe as a path segment and trivially comparable. |
| `entry` | Package-relative path to an `.html`/`.htm` file that exists in the archive (same path rules as every entry). |

**Optional metadata**

| Field | Rule |
|---|---|
| `description` | ≤ 500 chars. |
| `developer` | ≤ 80 chars. **Display text, not an identity claim** (see §7 "Integrity and trust"). |
| `icon` | Package-relative image path. |
| `category` | Short string (e.g. `Games`). |
| `permissions` | Subset of the existing Step-10 ids; see §8. Unknown ids → install refused (not silently dropped, so authors notice). |
| `window` | `{ "width", "height" }` initial size hint, clamped by the host. |
| `min_ltf` | `MAJOR.MINOR.PATCH`; refuse install on older LTF. |
| `network` | `"none"` \| `"optional"` \| `"required"`: an honest offline hint for the UI (§10). |

**Never accepted from a manifest** (the host decides): `runtime`, `type`,
`module`, `target`, `sandbox`, `allow`, `proxy`, `hidden`, `system`, ids of
other apps. Unknown top-level keys are ignored (forward compatibility) and
never copied anywhere. Hashes, sizes, screenshots and download URLs belong to
the **catalog**, not the manifest (a package can't meaningfully hash itself).

### Relationship to existing LTF app manifests: layered

1. `vapor.json`: the author's untrusted input, validated by the backend.
2. **Installed record**: a server-side, trusted record in `installed.json`
   (validated manifest fields + version, sha256, size, granted permissions,
   install time, source).
3. **Registry entry**: synthesized on the frontend from the installed record
   through a **fixed allowlist**:
   `{ id: "vapor:<id>", name, type: "web-app", runtime: "package", module: "webapp", icon, category: "Games", description, version, permissions: <granted>, default_size: <clamped>, vapor: { id, version, entry } }`.

Why layered: installed titles get the whole existing app surface for free
(windows, taskbar pinning, desktop shortcuts, Start, per-app storage and window
APIs) without inventing a second app system. The untrusted manifest never
becomes registry configuration. The `vapor:` prefix makes package ids
**disjoint by construction** from built-ins and from local `web-*` apps.
Built-in ids never contain `:`, and a `catalog_is_valid` assertion can pin
that.

> ✅ **Precondition — fixed in Step 21 (§15.4).** Step 20 found that the registry
> merged stored local apps as `{ ...ua, ...userManifest(...) }`, so a stored
> `module` survived and chose which same-origin script the **shell** imported
> (the same applied to `fallback` and `panel`). Local apps are now built only
> by `registry.localManifest` (validated core + allowlisted display strings),
> `web-app`/`browser` types always use their container module, and every
> dynamic import goes through the fixed allowlist in `core/modules.js`. Vapor's
> registry synthesis must use the same pattern: allowlisted fields only, never
> a spread of package data.

---

## 4. Runtime integration

Add one runtime, **`package`**, through the Step-14 seam: one entry in
`runtimes.js`, one handler in `webapp.js`, and an update to the expected set in
`tests/runtime-contract.test.mjs`.

- **Not `direct`/`embed`.** Those load a **remote** `target` with preflight and
  `SANDBOX_WEB`, which includes `allow-same-origin` (`frame.js:32`). Package
  content is local and must be **opaque-origin**.
- **Handler.** `mountPackage(env)` builds the launch URL itself from
  `app.vapor` (`/vapor/pkg/<id>/<version>/<entry>`, prefix-checked) and **never
  reads `target`**. It calls `createFrame({ sandbox: SANDBOX_PACKAGE, allow: 'autoplay; fullscreen; gamepad', … })`.
  Relative URLs already skip preflight and an explicit `sandbox` is already
  honoured (`frame.js:127,158`), so **`frame.js` needs no change**. The handler
  returns the standard frame instance, so the WM lifecycle (focus, minimize and
  suspend, restore, close/destroy) is unchanged.
- **`SANDBOX_PACKAGE`** (host constant; manifests can't widen it):
  `allow-scripts allow-pointer-lock allow-orientation-lock`.
  **Never** `allow-same-origin` (with a same-server `src`, that plus scripts
  equals shell escape), `allow-top-navigation*`, `allow-popups*` (links out go
  through `ltf.open`, which is permission-gated), `allow-modals` (a looping
  `alert()` freezes the whole shell tab), or `allow-downloads`.
- **Not user-selectable.** Once `package` is in `RUNTIMES`, local web apps
  could pick it and the App Store would list it. Add a `selectable: false` flag
  to the runtime definition, used by `validateWebAppFields` and the App Store
  dialog. The handler also refuses to mount any entry without a valid
  `app.vapor` record (it fails closed like Step 15's `mountUnavailable`).
- `proxy: "isolated"` stays orthogonal and is **not used** for packages.

---

## 5. Storage

Follow the existing convention: all mutable state lives under the single
configurable `data_dir` (`LTF_DATA_DIR`, default `data/`, gitignored). There are
no OS-specific paths anywhere in LTF today, and this design adds none. On
Windows, macOS and Linux alike the location is whatever the operator sets;
portable/dev mode is the default relative `data/`.

```text
data_dir/vapor/
  installed.json                      # { "<id>": { active, previous?, versions: {…records…} } }
  packages/<id>/<version>/            # extracted, read-only after install
    …files…
  packages/<id>/<version>.vapor       # original verified archive (export, re-verify, repair)
  packages/<id>/<version>.index.json  # install-time file index: { path → { size, mime } }
  staging/<random>/                   # download + extraction workspace, same filesystem
```

- Addressed only by `(id, version)`, both validated to path-safe grammars.
  The frontend never sees or sends a filesystem path.
- `installed.json` writes use the existing `write_lock` plus a temp-file-and-rename
  pattern (`state.rs`).
- Removal deletes `packages/<id>/` and the record, and **clears the package's
  `ltf.storage` namespace** (`ltf:appdata:vapor:<id>:`). Without that, saves
  would outlive uninstall.
- Packages are never placed under `static_dir`. `ServeDir` (`main.rs:103`)
  would serve them same-origin and unsandboxed, like the bundled games.

---

## 6. Installation pipeline

```text
Vapor UI: user picks a catalog item → shows declared permissions → confirm
  POST /api/vapor/install { catalog_id }                      (CSRF-guarded /api)
backend:
  1. resolve catalog_id → package { url, sha256, size, version } from the
     operator catalog it loaded itself (a request can never supply a URL)
  2. download to staging via guard.rs rules (https, public addresses only,
     redirects re-validated), stop at declared size and at the global cap
  3. sha256(bytes) == catalog sha256 and length == declared size, else discard
  4. archive validation from the central directory, before extracting anything
  5. read vapor.json (≤ 64 KiB), validate (§3), require id/version == catalog
  6. streaming extraction: count real bytes (never trust header sizes), write only
     index-listed paths built from validated components, never follow links
  7. write file index + keep original archive
  8. fsync, atomic rename staging/<rnd> → packages/<id>/<version>
  9. update installed.json (active = version, granted permissions = user-confirmed)
 10. emit a vapor-installed event (over /ws once it is Origin-checked, or the UI polls)
frontend: registry reload → title appears in Library/Start → Play
```

**Archive validation (step 4).** Reject the whole package on any of:

- absolute paths, drive letters, `..` segments, backslashes, NUL/control
  characters, empty segments;
- depth > 16 or path > 255 bytes;
- duplicates, including after Unicode NFC and case-folding (collisions on
  Windows/macOS filesystems);
- non-regular entries: symlink/device/FIFO mode bits (directories are implied,
  not created from entries);
- encrypted entries, or compression methods other than stored/deflate;
- more than 10,000 entries; any file over 128 MiB; total uncompressed over
  512 MiB; compressed archive over 256 MiB;
- a per-entry expansion ratio over 100:1 (decompression bomb).

All limits are config-overridable constants. Failure at any step deletes
staging and leaves any previously installed version untouched. Only one
install runs at a time.

**Sideloading** (installing a local `.vapor` without a catalog hash) is a
developer feature (Phase F). It runs the same pipeline minus step 3, is marked
`source: "sideload"`, and shows an explicit "unverified" warning.

**Integrity and trust.**

- **Transport integrity:** HTTPS plus sha256 in the catalog proves the bytes
  are the ones the catalog named.
- **It does not prove who made them.** Authenticity equals trust in the catalog
  source, which in v1 is operator-controlled (`content/games.json`; later
  `LTF_VAPOR_CATALOG_URL`). There is no user-typed catalog or package URL.
  `developer` is display text only.
- **Publisher signatures** (e.g. ed25519 over `id|version|sha256`) are deferred
  until there is real key distribution and a reason to trust keys. Shipping a
  signature format without a trust root would be security theatre.

---

## 7. Security model (threats → mitigations)

Assume every package is hostile.

### Archive / install

| Threat | Mitigation |
|---|---|
| Path traversal, `../`, absolute paths, drive letters | Grammar-validated components; output paths built from validated segments only; no `Path::join` of raw names. |
| Symlink/hardlink/device entries; writing outside the package | ZIP chosen; non-regular modes rejected; never follow links; extract into fresh staging. |
| Decompression bomb, huge manifest, huge files, entry floods | Central-directory pre-checks + streaming byte counting + ratio cap + manifest ≤ 64 KiB (§6). |
| Malformed archive | `zip` errors → reject; fuzz the validator in Phase A. |
| Case/Unicode collisions overwriting files | NFC + case-fold duplicate detection. |
| Backend used as a download proxy / SSRF | Install takes a **catalog id**; URL comes from the operator catalog; `guard.rs` rules; size caps; one job at a time. |
| Tampered package in transit | sha256 must match the catalog; HTTPS. |
| Manifest fields becoming configuration (e.g. `module` → shell import) | Allowlisted registry synthesis; force `module` (Phase 0); `vapor:` id namespace. |
| Id collision / squatting a built-in | `vapor:` prefix; built-in ids can't contain `:`. |

### Serving / browser

| Threat | Mitigation |
|---|---|
| Package reads the shell, `parent.ltf`, shell `localStorage` | Opaque origin (`SANDBOX_PACKAGE`, no `allow-same-origin`). **Verified:** `parent.*` → `SecurityError`. |
| Package calls `/api/*` (files, prefs, install) | Opaque origin + no CORS on `/api` + CSRF header guard. **Verified:** `fetch('/api/files')` → blocked. |
| Package document loaded top-level or in an unsandboxed frame (runs same-origin) | Every package response carries `Content-Security-Policy: sandbox allow-scripts allow-pointer-lock allow-orientation-lock` (the `page.rs:40` technique), so the document is opaque **however** it is loaded. Applies to HTML **and SVG/XML**. |
| Reading other packages' files or data | Every opaque document has a unique origin; storage only via the bridge, namespaced by host-resolved id; files are public-by-design static assets, not secrets. |
| Top-level navigation / popups / modal lock | No `allow-top-navigation*`, `allow-popups*`, `allow-modals`. |
| `/net/`, `/proxy/fetch` as data fetchers | Cross-origin to the package: `/net/` sends `CORP: same-origin` (`fetch.rs:98`), no CORS. A package *can* frame `/proxy/page` but can't read it (display only; same guards as any site). Accepted residual. |
| `/ws` event bus (prefs, file names) | **Fixed in Step 21 (§15.2):** the upgrade is refused unless `Origin` is exactly the request's own origin (was: 101 for `https://evil.example` and `null`). |
| DNS rebinding makes a hostile site same-origin with `/api` (including future install endpoints) | **Fixed in Step 21 (§15.1):** server-wide Host allowlist (`localhost`, IP literals, operator-listed exact names). |
| MIME sniffing / script-as-image | Extension→MIME allowlist, `X-Content-Type-Options: nosniff`, unknown → `application/octet-stream`. |
| Service-worker abuse | Opaque origins can't register service workers; the shell SW must bypass `/vapor/` (§10). |
| Cookies / credentials | LTF sets no cookies (verified: no `Set-Cookie` in `src/`); opaque origins have none; `/api` is unreadable. |
| Storage exhaustion (the whole LTF origin shares one `localStorage` quota) | Step 11 caps values at 100 KB but has no per-app total. Phase C adds a per-package total quota (e.g. 5 MB). |
| Notification spam / phishing via `ltf.open` | Opt-in permissions, confirmed at install; per-app notify rate limit (Phase C). |
| UI spoofing (fake LTF dialogs inside the game) | Host-controlled window title/icon from the installed record; no `document.title` override for packages. Residual: content inside the window is the author's. |
| CPU/memory denial of service (infinite loops) | Opaque frames may share the shell's renderer process, so a busy loop can jank the shell. Mitigations: close window, `suspendOnMinimize`. **Residual, documented honestly.** |
| Bundled first-party games | Remain trusted (same-origin). They are **part of the trusted base** and must never be the template for third-party content. |

### `window.ltf` bridge

**Step 20 finding:** the bridge identified a sender by **iframe element + `src`
attribute** and never checked `MessageEvent.origin`; replies went to
`targetOrigin = location.origin`. With an opaque frame whose `src` was
same-origin, **requests were accepted** (`notify` fired) **but replies were
dropped**.

**Step 21 (implemented, §15.3):** a `hello` is authenticated with `e.source`
(exact app iframe) + `e.origin` (must be the shell origin), then the host
transfers a private `MessageChannel` port to that document; all API traffic
uses the port and the window channel accepts nothing but `hello`.

**Phase C (updated recommendation — replaces "reply with `*`"):**

1. Add one explicit package clause to `expectedOrigin()`: the window's registry
   entry has `runtime: "package"`, the iframe `src` starts with
   `/vapor/pkg/<id>/<version>/`, and then the expected origin is `"null"`.
2. Deliver the port to such frames with `targetOrigin "*"` — the only option
   for an opaque document — sent **only** to the authenticated `e.source`. Any
   document inside that sandboxed frame is package-controlled (the sandbox
   flags apply to every navigation in it), so this grants nothing the package
   didn't already have. After that, replies travel on the port, so the old
   dropped-reply problem disappears without broadcasting anything.
3. Permissions come from the server-side installed record (granted at install),
   never from the message or the manifest at launch.

---

## 8. Permissions

Reuse the existing Step-10 capability ids. There is no Vapor-specific system:
the allowlist is small, host-enforced and already tested.

| Capability | Package default | Why |
|---|---|---|
| `storage` | **Granted** | Opaque origins can't use `localStorage`/`indexedDB` (verified: `SecurityError`), so this is the save-game path. Its own namespace (`vapor:<id>`), 100 KB/value, plus the new per-package quota. |
| `window` | Opt-in | Low risk (own window only), but not needed by default. |
| `notifications` | Opt-in, confirmed at install | Spam and phishing surface; add a rate limit. |
| `open-external` | Opt-in, confirmed at install | Opens arbitrary http(s) in Orion, a phishing surface. |
| System/network stats, files, registry, apps, install, prefs | **Never** | Not package capabilities; they stay first-party `/api`. |

The manifest *declares*; the user *confirms*; the backend *records*; the bridge
*enforces* from the record. Packages don't inherit desktop privileges from being
installed. Changing the grant later is a Library action (Phase D).

---

## 9. Origin / isolation model

**Model A — opaque-origin sandbox on the shell server (default, Phase C).**
Package files are served from `/vapor/pkg/<id>/<version>/…` and rendered with
`SANDBOX_PACKAGE` plus the CSP `sandbox` header.

- Every package document gets a unique opaque origin: no access to the shell,
  `/api`, other packages, cookies or the SW.
- Package responses must send `Access-Control-Allow-Origin: *`. **Verified:**
  without it, the bundled module game fails to boot in an opaque frame, because
  module imports and `fetch()` of its own files become CORS requests. That's
  safe because package files are public static assets and the header is scoped
  to `/vapor/pkg/` only, never `/api`, `/net` or `/proxy`.
- Works on any deployment (localhost, IP, remote, any browser) with no DNS or
  TLS infrastructure.
- **Compatibility cost:** no direct `localStorage`/`indexedDB`/SW. Games must
  save via `ltf.storage` or tolerate storage failure. The bundled games already
  wrap `localStorage` in try/catch, so they would run but not keep high scores
  until ported.

**Model B — per-package origin (`<id>.pkg.localhost:<port>`), optional later.**
Full web-platform compatibility (own `localStorage`, IndexedDB, SW, same-origin
modules, no CORS) with per-package isolation by real origin.

- **Verified:** Chromium resolves `*.localhost` to loopback.
- **Also verified:** today's server answers any `Host`, so a package origin
  would reach **its own** `/api` (`/api/ping` answered on
  `blocks.pkg.localhost`).
- Hard prerequisite: Host-based routing that serves **only that package's
  files** on package hosts (never `/api`, `/ws`, `/proxy`, `/net`, the shell or
  other packages).
- Other costs: Firefox/Safari `*.localhost` behaviour must be verified; remote
  deployments need wildcard DNS plus TLS; uninstall must clear per-origin
  storage (`Clear-Site-Data`).
- Considered only as an opt-in mode on top of Step 21's Host policy — as a
  separate, structured package-host class, never by widening that list.

**Decision:** ship Model A. Its failure mode is "a game can't save" rather than
"a game reads your files".

Other isolation rules:

- **Concurrent launches:** one window per title (the existing `single` rule).
  Versioned, immutable URLs mean an update never changes files under a running
  game.
- **Shared origin:** no two packages ever share one. In Model A every document
  is uniquely opaque, and storage is namespaced by host-resolved id.

---

## 10. Offline model

**What "offline" means here: no internet, and the LTF server is still
reachable** (the normal local install: `cargo run` → `localhost:8080`, README).

| Scenario | Works offline? |
|---|---|
| Launch an installed package | **Yes.** Files are on the LTF server's disk and served locally; no network or SW needed. |
| Package that needs its own online services (multiplayer, CDN assets) | No. Vapor can't fix that; the manifest `network` hint lets the UI say so honestly. |
| Browse remote catalog / install / update | No (downloads need the internet). A local `content/games.json` with local package URLs works for development. |
| LTF hosted remotely, client offline | Nothing works; out of scope. |

**Service worker.** The shell SW caches every same-origin basic `GET`
network-first into the shell cache (`sw.js:122`) and bypasses only `/api/`,
`/proxy/`, `/ws` (`sw.js:55`).

- Package documents are opaque and not SW clients, so their subresource
  requests already bypass it.
- Shell-initiated requests to `/vapor/pkg/` (icons in the Library) would be
  cached forever in the shell cache.
- Phase C therefore adds `/vapor/` to the SW bypass list (a one-line change).
  Packages don't need SW caching: they are already local, immutable and
  `Cache-Control: immutable`.

---

## 11. Export model

| Kind | Scope |
|---|---|
| LTF-native package (`.vapor`) | What Vapor installs and runs. |
| **Exportable HTML package** | The **original verified `.vapor` bytes**, served as `<id>-<version>.zip` (same sha256). Only if the catalog marks the item `exportable: true` (publisher intent/licensing; default `false`). |
| Executables / native apps | **Out of scope.** Vapor never downloads or runs native binaries. |

Running an export outside LTF works for a well-behaved HTML project. Limitations:

- Opening `index.html` via `file://` breaks ES modules and `fetch()`; users need
  any static server (e.g. `python -m http.server`).
- `window.ltf` is absent, so games should feature-detect
  (`const store = window.ltf?.storage ?? localStorageAdapter`), which also gives
  them saves outside LTF.
- Absolute-path assets (`/assets/…`) break under subpaths; the Phase-F validator
  should warn on them.

---

## 12. Catalog

Evolve the existing `content/games.json`; don't add a new service.

```json
{ "id": "blocks-community", "title": "…", "cover": "…", "screenshots": ["…"],
  "developer": "…", "genres": ["…"], "exportable": false,
  "package": { "version": "1.0.0", "url": "https://…/blocks-1.0.0.vapor",
               "sha256": "<64 hex>", "size": 123456 } }
```

- Items **without** `package` keep today's behaviour (`launch` URL) for the
  bundled first-party games, so the change is backwards compatible.
- Store art (covers, screenshots) lives in the catalog, not the package; remote
  art displays through the existing `/net/` path.
- A remote catalog later means an operator setting (`LTF_VAPOR_CATALOG_URL`):
  fetched by the backend with `guard.rs` rules, schema-validated and cached.
  Never a user-typed URL in v1.

---

## 13. Updates

- **Comparison:** strict semver `MAJOR.MINOR.PATCH`. Downgrades are refused
  unless explicit.
- **Replacement:** install the new version **side by side** in
  `packages/<id>/<new>/` through the full pipeline, then atomically flip
  `active` in `installed.json`. Keep the previous version as `previous`
  (rollback = flip back); delete N−2.
- **Failure handling:** any step failing discards staging, and the old version
  stays active and untouched.
- **Saves:** kept automatically, because the storage namespace is the package
  id, not the version.
- **Running games:** they keep their versioned URLs until relaunched, which is
  safe because files are immutable.
- **Permissions:** new permissions in an update require re-confirmation; until
  then the old grant applies.

---

## 14. Implementation roadmap

Small, independently testable steps. Each keeps existing suites green.

**Phase 0: security prerequisites — ✅ done in Step 21 (§15).**

- **0.1** Host-header allowlist (DNS rebinding).
- **0.2** Origin check on `/ws`.
- **0.3** Bridge caller authentication (`e.source` + `e.origin` + port).
- **0.4** Trusted-module allowlist; local apps from allowlisted fields only.

**Phase A: foundation (Rust, no routes).**

- **A.1** `vapor.json` schema and validator as a pure function, with unit tests.
- **A.2** Id/version/path grammars.
- **A.3** Archive validator over an in-memory ZIP. Adds the `zip` crate with
  deflate only; this is the first new dependency, justified there.
- **A.4** Config limits and the `data_dir/vapor` layout constants.
- **A.5** Fuzz-style tests: traversal, symlink modes, bombs, duplicates, case
  collisions.

**Phase B: installation.**

- **B.1** Staging plus safe extraction plus the file index.
- **B.2** Catalog `package` fields; `POST /api/vapor/install { catalog_id }`
  with guarded download and sha256 check. Tests use a local mock server, so
  they run offline, like netstats.
- **B.3** `GET /api/vapor/installed` (records only).
- **B.4** `DELETE /api/vapor/packages/<id>`, which also clears package storage.

**Phase C: launching and isolation.**

- **C.1** `GET /vapor/pkg/<id>/<version>/<path>`: index-resolved, CSP sandbox,
  CORS `*`, nosniff, MIME allowlist, immutable.
- **C.2** `package` runtime (`selectable: false`) and `mountPackage`.
- **C.3** Registry synthesis from the allowlist.
- **C.4** Package-aware bridge (`"null"` origin, `*` replies, grant from the
  record, per-package storage quota, notify rate limit).
- **C.5** SW bypass for `/vapor/`.
- **C.6** Browser regression tests that turn Appendix A's probes into
  assertions: the package can't reach parent, `/api`, shell storage or other
  packages; the module game boots with CORS; top-level navigation to a package
  URL is still sandboxed.

**Phase D: library.** Vapor shows installed titles with Install/Play/Remove,
the permission confirmation dialog, and permission management. Dogfood by
repackaging Blocks, Snake and Pong as `.vapor` packages whose storage adapter
falls back gracefully.

**Phase E: catalog and updates.** Side-by-side update, flip and rollback;
remote operator catalog; export endpoint for `exportable` items.

**Phase F: developer tooling.**

- `ltf-os vapor validate <dir>` / `ltf-os vapor pack <dir>` CLI subcommands
  that reuse the Phase-A validator.
- Dev-mode sideload/preview, clearly marked unverified.
- A template game plus the `ltf.storage` adapter pattern.

A basic package is then just `vapor.json` + `index.html`.

**Later/optional:** Model B per-package origins (after 0.1); publisher
signatures once a trust root exists.

**Out of scope for Vapor:** native executables, DRM/auth/paywall/anti-bot
circumvention, and **any expansion of `/proxy/page`**. `/proxy/page` remains
the conservative isolated-webpage mechanism. Vapor packages are locally
installed content and never route through it or use it to bypass a site's
restrictions.

---

## 15. Implemented security prerequisites (Step 21)

All four Phase-0 items are enforced and covered by durable tests
(`cargo test`, `tests/security-contract.test.mjs`,
`tests/browser/security.browser.mjs`), each mutation-checked.

### 15.1 Host policy (`src/hosts.rs`, outermost middleware in `build_app`)

Every request — API, static shell, web layer, `/ws` — must name a trusted host.
HTTP/1.1 uses `Host`; HTTP/2 the URI authority; if both exist they must agree.
A missing or untrusted host gets `403 unrecognized host`.

| Accepted (any valid port, or none) | Rejected |
|---|---|
| `localhost` | any other hostname: `evil.example`, `localhost.evil.example`, `127.0.0.1.nip.io`, `*.localhost` (incl. `blocks.pkg.localhost`), `localhost.` |
| IPv4 / bracketed IPv6 literals (`127.0.0.1`, `192.168.1.20`, `[::1]`) — an IP literal can't be produced by DNS rebinding | `0.0.0.0`, `[::]`; non-canonical numbers (`127.1`, `0x7f.0.0.1`, `2130706433`) |
| exact names in `LTF_ALLOWED_HOSTS` (comma-separated; for LAN names / reverse proxies) | malformed: userinfo, paths, spaces, bad ports, IPv6 zone ids, missing Host |

The port is not a trust signal (reverse proxies change it); the hostname is.
Invalid `LTF_ALLOWED_HOSTS` entries (wildcards, ports, IPs) are ignored with a
warning — they never widen trust. **Future package hosts (Model B)** must be a
separate host class that routes *only* to that package's files; never add a
wildcard or suffix rule to this list.

### 15.2 WebSocket Origin policy (`src/handlers/ws.rs`)

Checked on the upgrade request, **before** it becomes a WebSocket: `Origin`
must be exactly `http(s)://<this request's Host>` (same host, same effective
port) and that Host must be trusted. `null`, foreign, look-alike
(`http://127.0.0.1.evil.example`, `http://localhost:8080@evil.example`), other
ports, paths, non-http schemes and a missing `Origin` are refused with 403. The
only consumer is the shell (`static/js/core/api.js`), a same-origin browser
page, so there is no legitimate Origin-less client.

### 15.3 Bridge authentication (`static/js/core/appbridge.js`, `static/ltf-api.js`)

1. The window `message` channel accepts only `{ type: 'hello' }`.
2. A hello is honoured only if `event.source` is the `contentWindow` of an
   iframe inside a registered app window (browser-enforced), that iframe is
   meant for first-party content (same-origin `src`, not `/proxy/`), **and**
   `event.origin` equals the shell origin. The `src` alone is never trusted: a
   first-party frame that navigated to another origin is refused.
3. The host transfers a fresh `MessageChannel` port to that document with
   `targetOrigin` = the verified origin (a second, independent check). The port
   is an unguessable object capability — no token strings, nothing in URLs —
   bound to (app id, window id, iframe). All requests and replies use it.
4. The port is closed when the window closes, the iframe leaves the DOM, or the
   frame says hello again (reload / new document); every request also re-checks
   that its binding is live. A leaked or stale port can't act.
5. Permissions are unchanged: checked per request from the host registry, never
   from the payload; the app id and window come from the binding, never the
   payload.
6. Opaque-origin frames get no port today (`event.origin` is `"null"` for every
   opaque document). §7 describes the explicit Phase-C clause.

The public `window.ltf` API is unchanged; calls made before the handshake are
queued.

### 15.4 Trusted modules (`static/js/core/modules.js`, `core/registry.js`)

The shell imports app code by name in three places — `registry.loadModule`
(`apps/<name>.js`), the web container's `fallback` and `panel`. Each goes
through `trustedModule(kind, name)`: a frozen allowlist defined by LTF
(`app`: appstore, notepad, orion, settings, spiceify, vapor, webapp;
`fallback`: youtube; `panel`: geforcenow), a bare-name grammar, and own-list
membership — so unknown names, traversal, absolute/protocol/`javascript:`/`data:`
URLs, encoded variants and inherited property names all fail closed with no
network request. Local apps are built only by `localManifest` (validated core +
`catalogId`/`description`/`version` strings + a plain glyph `icon`, and two
strictly typed options that can only reduce privilege: `proxy: "isolated"|"off"`
and `suspendOnMinimize: true`); stored `module`, `fallback`, `panel`,
`sandbox`, `allow`, `controls`, `type` and anything else are dropped. Existing local apps keep working (they were
always `web-app` → `webapp`); junk fields in old stored entries are simply
ignored. A contract test checks every built-in resolves to a listed module and
every listed module has a file.

---

## Appendix A — evidence

Reproduced in Chromium (Playwright) against a throwaway `ltf-os` (temp
`LTF_DATA_DIR`, netcheck disabled), Step 20. Scripts were research-only and are
not part of the repo; the checks become Phase C regression tests.

| Probe | Result |
|---|---|
| Bundled game via `wm.open('webplayer', { url: 'games/blocks.html' })`: iframe `sandbox` attribute | `null` (none) |
| … `location.origin === parent.location.origin` | `true` |
| … `parent.ltf.wm.open` / `parent.ltf.registry.get` callable | `true` |
| … `typeof localStorage.getItem('ltf:prefs')` | `"string"` (shell storage readable) |
| … `fetch('/api/files', { headers: { 'X-LTF-Client': '1' } })` | `200` |
| Same game in an iframe with `SANDBOX_ISOLATED` tokens (opaque): `self.origin` | `"null"` |
| … `localStorage` / `indexedDB` | `SecurityError` / `SecurityError` |
| … `parent.ltf` | `SecurityError` |
| … module game boots (`#help` populated) | `false` (module import CORS-blocked) |
| … `fetch('/games/game.css')`, `fetch('/api/files')` | both blocked (`TypeError`) |
| `http://blocks.pkg.localhost:<port>/api/ping` in Chromium | `200`, origin `http://blocks.pkg.localhost:<port>` |
| Opaque frame (same-origin `src`, in an app window) calling `ltf.ready()` / `ltf.notify()` | no reply (dropped) / toast shown (accepted) |
| `curl` WebSocket upgrade on `/ws` with `Origin: https://evil.example` and `Origin: null` | `101 Switching Protocols` for both |
