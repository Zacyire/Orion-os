# LTF OS — Step 13: Runtime Architecture Review & Extension Plan

Research/analysis step. **No functional changes** were made to LTF OS to produce
this document; it only reflects the code as it exists today and proposes a
future sequence. It does **not** implement a proxy runtime, URL rewriting, or
any new capability.

Everything below was traced from the actual source, not from prior reports.

---

## 1. Current runtime architecture

There is no standalone "runtime engine." A web app's runtime is decided by a few
manifest fields that flow, unchanged, from the catalogue into one shared web
container. The moving parts:

- **`static/apps.json`** — built-in catalogue, embedded into the Rust binary via
  `include_str!` (`src/catalog.rs`) and also served statically.
- **`src/handlers/apps.rs::list`** — serves `/api/apps`: each `CatalogApp` is
  serialised (all unknown fields pass through via `#[serde(flatten)] extra`),
  then `module` (`resolved_module()`) and `installed` are added.
- **`static/js/core/registry.js`** — loads `/api/apps` (or static `apps.json`
  offline), `normalize()`s each entry, merges localStorage user apps
  (`ltf:user-apps`) and the install catalog (`catalog.json`). `loadModule(id)`
  dynamically imports `../apps/<module>.js`.
- **`static/js/apps/webapp.js`** — the module for every `type: "web-app"`. This
  is where **runtime selection actually happens**.
- **`static/js/core/frame.js` (`createFrame`)** — the shared AppFrame used by
  both web-apps and Orion tabs. Owns preflight, iframe creation, sandboxing,
  error screens, suspend/resume.
- **`static/js/core/wm.js`** — the window manager: creates the window, calls
  `mod.mount(body, ctx)`, and drives lifecycle. It knows nothing about runtimes.

Key structural fact: **runtime is two independent axes, not one enum.**

1. `runtime` (semantic delivery mode): `"direct" | "embed" | "external"`.
2. `proxy` (isolation transport): `undefined/"off"` (direct iframe to the real
   origin) vs `"isolated"` (rendered through `/proxy/page`, opaque origin).

`webapp.js` reads axis 1; `frame.js` reads axis 2 (`app.proxy === 'isolated'` or
`args.proxy`). They compose.

---

## 2. Actual runtime-selection flow

```
apps.json / localStorage / catalog.json
        │
        ▼
registry.load() ──► normalize() ──► byId map      (adds defaults: icon, category,
        │                                           version, default_size, module,
        │                                           permissions:[])
        ▼
wm.open(appId) ──► registry.loadModule(appId) ──► import apps/<module>.js
        │            (web-app → "webapp", browser → "orion", native → id)
        ▼
wm.#createWindow() + wm.#mount(win, mod, ctx)
        │
        ▼
webapp.js mount(root, ctx):
    target  = args.url || app.target
    runtime = args.runtime || app.runtime || 'direct'
    isolated= args.proxy===true || args.proxy==='isolated' || app.proxy==='isolated'
        │
        ├── runtime === 'external' ──► mountExternal(): NO iframe.
        │                              Renders an "Open in Orion" hand-off screen;
        │                              button → ctx.open('orion', {url}); closes window.
        │
        └── runtime 'direct' OR 'embed' ──► createFrame({...}); frame.load(target,{isolated})
                                            (direct and embed take the SAME code path today)
        │
        ▼
frame.load(url):
    !isRemote(url) (relative) ─────────► mount(url,false): first-party iframe, no preflight
    isRemote(url) & check ─────────────► api.inspect(url)  → GET /api/web/inspect
         ├─ throws / !ok / !embeddable ─► native error screen (frame.js ERRORS)
         ├─ isolated & !isolated_available → isolated=false (non-HTML: nothing to isolate)
         └─ ok:
             isolated=false ──► <iframe src="https://site/…">       (SANDBOX_WEB)
             isolated=true  ──► <iframe src="/proxy/page?url=…">     (SANDBOX_ISOLATED)
        │
        ▼
window manager paints the window; onNavigate/onError/onOpen wire the frame back
to the app (e.g. link-outs open Orion).
```

**Important accuracy note:** in the current code `direct` and `embed` are the
**same execution path**. `embed` is only a *semantic label* meaning "`target` is
already a provider-supplied embed URL" (e.g. a YouTube `/embed/` player). Nothing
in `webapp.js` or `frame.js` branches on `embed` vs `direct`. The real
divergences are `external` (no iframe) and the orthogonal `proxy: "isolated"`
(different iframe `src` + sandbox).

---

## 3. Current runtime contract (fields that actually exist)

From `src/catalog.rs` (`CatalogApp`), `registry.js` (`normalize`,
`validateWebAppFields`, `userManifest`) and how `webapp.js`/`frame.js` consume
them. "Consumer" = who reads it.

| Field | Origin | Required? | Normalized? | Consumer / effect |
|---|---|---|---|---|
| `id` | manifest | **required** | — | registry key; storage/window namespace; `data-app` |
| `name` | manifest | **required** | trimmed, ≤60 (local) | window title, App Store, `ltf.app.name` |
| `type` | manifest | optional (dflt `native`) | `native`\|`web-app`\|`browser` | selects module (webapp/orion/native) |
| `module` | manifest/derived | optional | `resolved_module()` | which `apps/<module>.js` to import |
| `runtime` | manifest | optional (dflt `direct`) | local apps clamped to `direct\|embed\|external` | `webapp.js` selection axis 1 |
| `target` | manifest | required for web-app (non-hidden) | URL-validated (http/https) for local | the URL the AppFrame loads |
| `proxy` | manifest | optional (dflt off) | `off`\|`isolated` (Orion/webapp) | `frame.js` isolation axis 2 |
| `icon` | manifest | optional (dflt `web`) | glyph name; non-URL kept | icon tile (glyph) |
| `iconUrl` | manifest | optional | http(s)-validated | icon tile (image) |
| `permissions` | manifest | optional (dflt `[]`) | `normalizePermissions()` → known ids only | Step-10 capability gate (`appbridge.js`) |
| `catalogId` | install | optional | — | dedup/identity for catalog-installed apps |
| `version` | manifest | optional (dflt `1.0.0`) | — | App Store display, `ltf.app.version` |
| `publisher` | catalog.json | optional | mapped to `developer` in store | App Store metadata |
| `developer` | manifest | optional | — | App Store byline |
| `category` | manifest | optional (dflt `Web`) | — | App Store filtering |
| `local` | derived | — | set by `userManifest` | marks localStorage app (edit/remove) |
| `custom` | derived | — | set at runtime | server-added custom app |
| `system` | manifest | optional | — | cannot be uninstalled |
| `hidden` | manifest | optional | — | excluded from Start/App Store |
| `default_size` | manifest | optional (dflt 1180×740) | — | initial window size |
| `controls` | manifest | optional (dflt `[reload]`) | — | titlebar buttons (webapp.js `CONTROL_DEFS`) |
| `navigation` | manifest | optional | — | `limited`/`none`: keep app on its site |
| `allow` | manifest | optional | — | iframe permissions policy |
| `sandbox` | manifest | optional | `undefined` vs `null` vs tokens | iframe sandbox override |
| `fallback` | manifest | optional | — | module shown when embedding is refused |
| `panel` | manifest | optional | — | side-panel module (e.g. geforcenow) |
| `suspendOnMinimize` | manifest | optional | — | unload frame while minimized |

**Fields that matter to runtime selection specifically:** `type`, `runtime`,
`target`, `proxy`, and secondarily `fallback`, `allow`, `sandbox`, `navigation`.
Everything else is presentation, identity, or capability.

---

## 4. Runtime boundaries — where a new runtime can be added

A new runtime "conceptually like `runtime = "future-runtime"`" can be added
**without** touching the window manager, permissions, storage, or the LTF API —
because none of them branch on `runtime`. The only components that read `runtime`
are `webapp.js` (axis 1) and `frame.js` (axis 2, via `proxy`).

However, **there is a real seam problem for *local/user* apps**:

- `registry.js` hardcodes `const RUNTIMES = ['direct','embed','external']`.
  `validateWebAppFields()` silently clamps any other value to `'direct'`. So a
  user-installed app (New/Edit Web App, or `catalog.json` install) **cannot
  select a new runtime** — it would be normalized away.
- The App Store dialog (`appstore.js`) hardcodes exactly three `<option>`s.
- Built-in apps in `apps.json` are **not** subject to `validateWebAppFields`, so
  a new `runtime` value *can* already be added to a built-in app and handled in
  `webapp.js` — but it stays invisible to users.

So the architecture "naturally supports" new runtimes for **built-in** apps with
a single `webapp.js` branch, but **not** for **local** apps. The smallest seam
that fixes this for everyone:

1. Make the runtime list **data, not a literal**: export a
   `RUNTIMES`/`RUNTIME_LABELS` map from `registry.js` (mirroring how `PERMISSIONS`
   was handled in Step 10), have `validateWebAppFields` validate against it, and
   have `appstore.js` render `<option>`s from it.
2. Replace the `if (runtime === 'external')` conditional in `webapp.js` with a
   small **runtime table** (`runtime → handler`) so a new runtime is one entry,
   not an edit to the control flow.

This is the same pattern already proven twice (the `handlers` table and
`PERMISSIONS`/`PERMISSION_LABELS` in `appbridge.js`/`registry.js`). It is **not**
implemented in this step (Step 13 is analysis only); it is the recommended
Step 14.

---

## 5. `/proxy/page` today (`src/web/page.rs`)

**What it does:**
- `GET /proxy/page?url=` — server fetches the page and returns the HTML re-hosted
  from the LTF origin inside an **opaque-origin sandbox** (`Content-Security-Policy:
  sandbox …` **without** `allow-same-origin`). It cannot read LTF cookies,
  storage, or API responses.
- Injects `<base href>` so subresources load **directly from the real origin**
  (they are *not* proxied), plus a small shim that intercepts link clicks / GET
  form submits and routes the *next navigation* back through `/proxy/page`, and
  reports `navigate`/`title`/`open` to the owning window via `postMessage`
  (`source: 'ltf-proxy'`).
- Neutralises page `<meta http-equiv>` CSP / X-Frame-Options tags (renames the
  attribute) so the re-hosted document renders.
- Re-enforces framing policy server-side: a page that forbids embedding is still
  answered with `EMBEDDING_NOT_ALLOWED` and never rendered. Redirects bounce back
  through `/proxy/page` with per-hop re-validation (`guard.rs`).
- Streams non-HTML displayable types (image/video/audio/pdf/json/text) with
  size caps; refuses downloads/executables (`UNSUPPORTED_CONTENT`).
- Gated by `LTF_PROXY` (`cfg.proxy_enabled`); off → `PROXY_DISABLED`.

**What it does NOT do:**
- It does **not** rewrite links, script URLs, `fetch`/XHR, or asset URLs. It
  relies on `<base>` + per-navigation interception only. Subresources and
  in-page JS talk to the **real origin**, not the proxy.
- It forwards **no cookies, Authorization, or credentials**; logins/paywalls
  stay as the site set them.
- It does **nothing** to bypass X-Frame-Options/CSP framing, DRM, bot checks, or
  rate limits. Framing bans are respected.
- It is not wired as a `runtime` value. It is reached only via the orthogonal
  `proxy: "isolated"` flag (or Orion's isolated mode), through `frame.js`.

**How `frame.js` uses it:** when `isolated` is true and the preflight reports
`isolated_available` (HTML + proxy enabled + embeddable), `frame.load` sets the
iframe `src` to `pageUrl(url)` = `/proxy/page?url=…` with `SANDBOX_ISOLATED`
(no `allow-same-origin`). Navigation/title come back via the `ltf-proxy`
postMessage channel handled inside `createFrame`.

**Is it isolated from the LTF API?** Yes. The `/proxy/page` document runs in an
**opaque origin**, and `appbridge.js::senderApp` explicitly rejects any iframe
whose `src` starts with `/proxy/` (and any non-same-origin frame). So
`/proxy/page` content can never obtain `window.ltf` (metadata, storage,
notifications, open-external, window). This was re-verified in Steps 10–12
isolation tests.

**What it would take to become a full "web delivery" runtime:**
- A first-class `runtime` value (via the Step-14 seam) instead of the `proxy`
  side-flag, so it's selectable and testable like the others.
- A decision about **asset delivery**: today assets load from the real origin
  via `<base>`. A true isolated runtime that works for sites which *require*
  same-origin assets would need proxied subresources — i.e. URL rewriting or a
  `/net`-style asset router — which is explicitly **out of scope** and carries
  the most risk (correctness, security, legal). Not proposed here.
- Session/state handling (currently none, by design). Any credentialed use would
  be a large, separate design with its own security review.

No changes made; capabilities not expanded.

---

## 6. Service worker today (`static/sw.js`)

**Purpose:** an offline shell cache + a same-origin resource cache. It is **not**
a runtime and does not proxy site content.

- **Scope `/`, same-origin GET only.** Cross-origin requests are never
  intercepted (direct iframes/embeds talk to their own origins untouched).
- **Explicitly bypasses** `/api/*`, `/proxy/*`, `/ws`, `Range` requests, and
  media extensions (`.webm/.mp4/.mp3/.m3u8/…`) so live data, isolated documents
  (opaque-origin, not SW-controlled anyway), and streaming stay native.
- **`/net/<encoded-url>`** (backend `fetch.rs`): cache-first for images/fonts
  (LRU ~300 entries, 7-day TTL), in-flight coalescing, SVG placeholder on image
  failure. This is only OS-side extras (favicons, thumbnails, canvas-readable
  data), never a website's own traffic.
- **Navigations & other same-origin GETs** (JS/CSS/shell): network-first with a
  cache fallback for offline.

**Handles LTF-owned resources only?** Effectively yes — same-origin shell assets
plus the `/net/` OS-helper namespace (which is itself a guarded, credential-free
server GET). It never sees a web-app's cross-origin traffic.

**Can a future runtime coexist?** Yes. A direct/embed runtime is cross-origin →
already invisible to the SW. A `/proxy/page` runtime is under `/proxy/*` →
already bypassed. A local/offline runtime would *benefit* from the SW (that's
exactly the shell-cache mechanism). No SW change is needed to add runtimes; a
local/offline runtime is the only one that would later want SW involvement, and
even then additively. Not modified in this step.

---

## 7. Proposed minimal runtime contract

The current de-facto contract, made explicit. A runtime is the thing that turns
`(app, window)` into rendered content inside the AppFrame/window. Grounded in
what `webapp.js` already does:

```
Runtime (conceptual)
 ├── id            "direct" | "embed" | "external" | …          (matches manifest `runtime`)
 ├── canHandle(app)   → bool     // usually app.runtime === id; keeps selection declarative
 ├── mount(app, ctx)  → instance // ctx = the existing mount ctx (win, args, open, notify…)
 │        // builds UI in ctx.win.body: an AppFrame (direct/embed/isolated),
 │        //   a hand-off screen (external), or a native surface (local/offline)
 └── instance (already the webapp.js return shape — DO NOT invent a new one):
        ├── onArgs(args)     // re-open / new URL
        ├── onFocus()
        ├── onResize()
        ├── onMinimize() / onRestore()   // e.g. frame.suspend()/resume()
        ├── beforeClose() → bool
        └── destroy()
```

Notes:
- The **instance/lifecycle shape already exists** and is honoured by `wm.js`
  (`onArgs/onFocus/onResize/onMinimize/onRestore/beforeClose/destroy`). A runtime
  abstraction should **reuse it verbatim**, not introduce a parallel one.
- `canHandle`/`mount` is the only genuinely new surface, and it can live entirely
  inside `webapp.js` as a `runtime → { mount }` table. The window manager,
  permissions, storage, and LTF API stay untouched.
- Permissions remain **orthogonal** to runtime (Step-10 model). A runtime never
  grants capabilities; it only renders. `appbridge.js` isolation
  (same-origin + non-`/proxy/`) is what keeps privileged APIs away from
  cross-origin/isolated runtimes, and that must remain the invariant.

Recommendation: do **not** build a heavy `Runtime` class hierarchy. The smallest
correct abstraction is a lookup table of handlers keyed by `runtime`, sharing the
existing `createFrame` and the existing mount-instance contract.

---

## 8. Runtime comparison

Architectural differences only (not a ranking).

| Runtime | Current? | Purpose | Browser iframe | Backend involvement | LTF API? | Architectural role / difference |
|---|---|---|---|---|---|---|
| **direct** | yes | Show a site as an app in its own origin | Yes — `<iframe src=https://site>`, `SANDBOX_WEB` (incl. `allow-same-origin`) | Preflight only (`/api/web/inspect`); traffic goes browser→site | No (cross-origin) | Baseline. Site's own cookies/CSP/DRM apply; LTF never sees traffic. Fails when the site sends X-Frame-Options/frame-ancestors. |
| **embed** | yes (label only) | Load a provider's official embed URL | Yes — identical code path to direct | Same as direct | No (cross-origin) | **No distinct code today.** Semantic marker that `target` is an embeddable player/URL. Candidate to either formalise or merge. |
| **external** | yes | Hand off to Orion / new tab for sites that shouldn't/can't be framed | No iframe | None (Orion does its own preflight when opened) | No (its own window is Orion, not the app) | The graceful-degradation path. `mountExternal()` renders an "Open in Orion" screen. |
| **proxy / isolated (`proxy:"isolated"`)** | partial (transport, not a `runtime`) | Render framing-refusing HTML in an opaque-origin sandbox | Yes — `<iframe src=/proxy/page>`, `SANDBOX_ISOLATED` (no `allow-same-origin`) | Heavy: `page.rs` fetches, re-hosts HTML, injects `<base>`+shim, re-enforces framing | **No** (blocked by opaque origin + `/proxy/` gate) | Closest thing to a "web delivery" runtime, but reached via a side-flag, not `runtime`. Assets still load from real origin; no URL rewriting. |
| **local / offline** | future | Run bundled/first-party content with no network | Yes — first-party iframe (relative `target`, no preflight) — mechanism already exists | None at load; SW shell-cache enables offline | Yes if first-party same-origin (the game host already does this) | Would reuse the existing relative-URL path + SW caching. Additive; lowest risk. |
| **streaming / remote** | future | Pixel/stream a remote session (cloud desktop/game) | Likely `<iframe>`/`<video>`/`<canvas>` to a streaming endpoint | New: signalling/session backend (out of current scope) | No (cross-origin/opaque) | Most different: needs latency/session/media handling and a real backend service. Largest new surface. |

---

## 9. Recommended future implementation sequence

Smallest safe progression grounded in the code:

- **Step 13 — Architecture review (this doc).** No code.
- **Step 14 — Runtime seam (tiny, additive).** Turn the hardcoded
  `RUNTIMES` list into exported data (`registry.js`), validate/render local-app
  runtimes from it (`validateWebAppFields`, `appstore.js`), and replace the
  `webapp.js` `if (runtime==='external')` with a `runtime → handler` table.
  Behaviour-preserving: `direct/embed/external` produce identical output. This
  removes the only real barrier (local apps can't pick new runtimes) using the
  proven table pattern. No WM/permission/API/store-redesign.
- **Step 15 — Runtime contract tests.** Lock the mount-instance lifecycle and
  selection behaviour with Playwright + the existing patterns, and add a Rust
  test that every built-in `runtime` value is one the table handles. This makes
  Step 16 safe.
- **Step 16 — First *new* runtime = `local`/offline (lowest risk).** Formalise
  the already-working first-party relative-`target` path as a selectable runtime;
  optionally let it opt into SW precache. No backend, no proxy.
- **Step 17 — Decide `embed`'s fate.** Either give it distinct behaviour
  (e.g. provider-embed validation/aspect handling) or explicitly document it as
  an alias of `direct`. Cheap, clarifying.
- **Step 18+ — (Only if a real product need exists) LTF-controlled web-delivery
  runtime.** Promote `/proxy/page` from a side-flag to a first-class runtime
  *behind a dedicated design + security review*. This is where asset delivery,
  session/state, and legal/policy questions live; it should not be started until
  14–16 exist. Streaming/remote is a separate, later track with its own backend.

Rationale: each step is one seam or one runtime, reversible, and never touches
more than one subsystem at a time.

---

## 10. Architectural risks / technical debt discovered

1. **`direct` and `embed` are indistinguishable in code.** The manifest and UI
   present three runtimes; the engine implements two-and-a-bit. Low harm today,
   but it means tests can't tell them apart and users may expect embed-specific
   behaviour that doesn't exist. (Step 17.)
2. **Runtime list is a hardcoded literal in three places** (`registry.RUNTIMES`,
   `validateWebAppFields`, `appstore.js` options). Adding a runtime for *local*
   apps currently requires editing all three; built-ins bypass it entirely. This
   is the main extension seam and the main inconsistency. (Step 14.)
3. **Two orthogonal axes (`runtime` + `proxy`) with no single vocabulary.**
   Isolation is a transport flag, not a runtime, so "isolated" is discoverable
   only by reading `frame.js`. A future runtime abstraction should decide whether
   isolation is a runtime or a modifier — pick one and document it.
4. **Selection logic is imperative** (`if runtime === 'external' … else
   createFrame`). Fine for three modes; becomes brittle past that. The table
   refactor (Step 14) pre-empts this.
5. **`webapp.js` is the de-facto runtime host but isn't named as one.** Its mount
   return object *is* the lifecycle contract the WM depends on; that contract is
   currently implicit. Step 15 should make it explicit so new runtimes can't
   accidentally break `onMinimize/onResize/destroy`.
6. **No per-runtime capability constraints.** Permissions are app-level, not
   runtime-level. That's correct today, but a future streaming/proxy runtime may
   want to *forbid* certain permissions structurally; worth noting before then.

None of these are urgent; all are addressable additively.

---

## Confirmation: existing behaviour unchanged

This step made **no** functional changes:

- No new user-facing runtime, no proxy implementation, no URL rewriting.
- No backend, service-worker, window-manager, App Store, permissions, storage, or
  `window.ltf` changes.
- The only artifact produced is this document under `docs/`.

The single code change that Step 14 would need (making the runtime list data and
adding a handler table) is described, **not implemented**, per the step's
"prefer zero code changes" instruction.

---

## Status addendum (Steps 14–15)

- **Step 14 (`4588287`)** implemented the seam from §4: `static/js/core/runtimes.js`
  is the single runtime list; `webapp.js` dispatches through `RUNTIME_HANDLERS`;
  registry validation and the App Store read the same list.
- **Step 15** hardened it:
  - `RUNTIME_DEFS`, `RUNTIMES` and `RUNTIME_HANDLERS` are frozen.
  - Dispatch is exposed as `resolveRuntime()` / `missingRuntimeHandlers()` /
    `mountWithHandlers()` in `webapp.js`. Unknown values still normalize to
    `direct`, but a runtime that is **defined without a handler now fails closed**
    (a `RUNTIME_UNAVAILABLE` screen, nothing loaded) instead of silently using the
    direct frame.
  - Contract tests: `node --test tests/*.test.mjs` (no dependencies).
  - Browser regression tests: `cargo build && node tests/browser/runtime.browser.mjs`
    (self-contained: starts its own throwaway server and test site).
- To add a runtime: one entry in `runtimes.js`, one handler in `webapp.js`, and
  update the expected set in `tests/runtime-contract.test.mjs`.
