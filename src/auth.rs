//! Access gate for the live site.
//!
//! Orion OS is a single-owner desktop, so access is one shared
//! **access key** chosen by the operator (`LTF_ACCESS_KEY` /
//! `LTF_ACCESS_KEY_FILE`) — no accounts, profiles or third-party login. When a
//! key is configured, every route except `/login`, `/logout` and `/healthz`
//! requires a signed-in session; the gate runs just inside the trusted-Host
//! check, so `/ws`, `/api`, the web layer and the static shell are all covered.
//!
//! Sign-in: `POST /login` (form body, never a URL) with the key. The key is
//! compared in constant time; attempts are rate limited per client and
//! globally; the request must carry a same-origin `Origin`. On success the
//! browser gets a session cookie:
//!
//! ```text
//! __Host-orion_session=v1.<expiry>.<nonce>.<hmac>; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=…
//! ```
//!
//! (`orion_session` without `Secure`/`__Host-` in development mode, which may
//! run over plain http.) By default the sign-in is for **this browser session
//! only**: the cookie has no `Max-Age` (gone when the browser closes) and the
//! token itself expires after 12 hours — the safe choice on a shared or school
//! computer. Ticking "Keep me signed in" gives a persistent cookie for
//! `LTF_SESSION_HOURS` instead. The token is HMAC-SHA256 over its expiry and a random
//! nonce, keyed from the access key, so sessions survive restarts and
//! **changing the key signs everyone out**. `POST /logout` revokes the nonce
//! for the rest of this process's life and expires the cookie;
//! `POST /logout?erase=1` also sends `Clear-Site-Data: "cache", "storage"` so
//! the browser deletes Orion OS's local data (localStorage, caches, service
//! worker) — for leaving a shared computer clean.
//!
//! The key never appears in URLs, logs, responses, frontend source, app
//! manifests or WebSocket messages; `Config` holds it in a redacted `Secret`.

use std::{
    collections::HashMap,
    net::IpAddr,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ring::{
    hmac,
    rand::{SecureRandom, SystemRandom},
};

use crate::{config::Config, state::SharedState, web::limit::RateLimiter};

/// Longest key accepted from the form (the configured key is far shorter).
const MAX_KEY_LEN: usize = 1024;

/// Lifetime of a sign-in without "Keep me signed in" (shared computers).
const BROWSER_SESSION_SECS: u64 = 12 * 3600;

/// A verified session, attached to the request for handlers that outlive it
/// (the `/ws` event stream closes when its session expires or is revoked).
#[derive(Debug, Clone)]
pub struct Session {
    nonce: String,
    expires: u64,
}

pub struct Gate {
    /// Signs session tokens; derived from the access key.
    session_key: hmac::Key,
    /// Random per-process key used only to compare submitted keys in constant time.
    compare_key: hmac::Key,
    /// HMAC of the configured access key under `compare_key`.
    expected: hmac::Tag,
    ttl: Duration,
    secure: bool,
    rng: SystemRandom,
    /// Signed-out nonces → expiry, so a copied cookie stops working at logout.
    revoked: Mutex<HashMap<String, u64>>,
    per_client: RateLimiter,
    global: RateLimiter,
    trust_proxy_headers: bool,
}

impl Gate {
    /// `None` when no access key is configured (open development server).
    pub fn from_config(config: &Config) -> Option<Self> {
        let key = config.access_key.as_ref()?;
        let rng = SystemRandom::new();
        let root = hmac::Key::new(hmac::HMAC_SHA256, key.expose().as_bytes());
        let session_key = hmac::Key::new(hmac::HMAC_SHA256, hmac::sign(&root, b"orion-os session v1").as_ref());
        let compare_key = hmac::Key::generate(hmac::HMAC_SHA256, &rng).expect("system CSPRNG");
        let expected = hmac::sign(&compare_key, key.expose().as_bytes());
        Some(Gate {
            session_key,
            compare_key,
            expected,
            ttl: Duration::from_secs(config.session_hours * 3600),
            secure: config.secure_cookies(),
            rng,
            revoked: Mutex::new(HashMap::new()),
            // 10 attempts/min per client (burst 10), 60/min across all clients.
            per_client: RateLimiter::new(10),
            global: RateLimiter::new(60),
            trust_proxy_headers: config.trust_proxy_headers,
        })
    }

    pub fn cookie_name(&self) -> &'static str {
        if self.secure {
            "__Host-orion_session"
        } else {
            "orion_session"
        }
    }

    fn key_matches(&self, submitted: &str) -> bool {
        submitted.len() <= MAX_KEY_LEN && hmac::verify(&self.compare_key, submitted.as_bytes(), self.expected.as_ref()).is_ok()
    }

    fn issue(&self, lifetime_secs: u64) -> String {
        let mut nonce = [0u8; 18];
        self.rng.fill(&mut nonce).expect("system CSPRNG");
        let body = format!("v1.{}.{}", now() + lifetime_secs, URL_SAFE_NO_PAD.encode(nonce));
        let mac = hmac::sign(&self.session_key, body.as_bytes());
        format!("{body}.{}", URL_SAFE_NO_PAD.encode(mac.as_ref()))
    }

    /// Verify a token: signature, expiry, not revoked.
    fn verify(&self, token: &str) -> Option<Session> {
        let (body, mac) = token.rsplit_once('.')?;
        let mac = URL_SAFE_NO_PAD.decode(mac).ok()?;
        hmac::verify(&self.session_key, body.as_bytes(), &mac).ok()?;
        let mut parts = body.split('.');
        let (Some("v1"), Some(exp), Some(nonce), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
            return None;
        };
        let expires: u64 = exp.parse().ok()?;
        let session = Session { nonce: nonce.to_string(), expires };
        self.is_live(&session).then_some(session)
    }

    /// Still valid now (not expired, not signed out)?
    pub fn is_live(&self, s: &Session) -> bool {
        s.expires > now() && !self.revoked.lock().unwrap_or_else(|p| p.into_inner()).contains_key(&s.nonce)
    }

    fn revoke(&self, s: &Session) {
        let mut map = self.revoked.lock().unwrap_or_else(|p| p.into_inner());
        let t = now();
        map.retain(|_, exp| *exp > t);
        map.insert(s.nonce.clone(), s.expires);
    }

    /// The session named by this request's cookie, if valid.
    pub fn session(&self, headers: &HeaderMap) -> Option<Session> {
        let name = self.cookie_name();
        headers
            .get_all(header::COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(';'))
            .filter_map(|pair| pair.trim().split_once('='))
            .filter(|(k, _)| *k == name)
            .find_map(|(_, v)| self.verify(v))
    }

    /// `max_age: None` = a browser-session cookie (deleted when the browser closes).
    fn set_cookie(&self, value: &str, max_age: Option<u64>) -> HeaderValue {
        let secure = if self.secure { "; Secure" } else { "" };
        let max_age = max_age.map(|s| format!("; Max-Age={s}")).unwrap_or_default();
        HeaderValue::from_str(&format!("{}={value}; Path=/; HttpOnly; SameSite=Lax{max_age}{secure}", self.cookie_name()))
            .expect("cookie is ASCII")
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Paths that must work without a session.
fn is_public(path: &str) -> bool {
    matches!(path, "/login" | "/logout" | "/healthz")
}

/// Middleware: require a signed-in session when an access key is configured.
pub async fn require_access(State(state): State<SharedState>, mut req: Request, next: Next) -> Response {
    let Some(gate) = &state.gate else {
        return next.run(req).await;
    };
    if is_public(req.uri().path()) {
        return next.run(req).await;
    }
    match gate.session(req.headers()) {
        Some(session) => {
            req.extensions_mut().insert(session);
            next.run(req).await
        }
        None => unauthenticated(&req),
    }
}

/// 401 for anything without a session: the sign-in page for browser
/// navigations, a small JSON error for everything else (API, `/ws`, assets).
/// Never a redirect, so the service worker can't cache a sign-in page as `/`.
fn unauthenticated(req: &Request) -> Response {
    let path = req.uri().path();
    let wants_html = matches!(*req.method(), Method::GET | Method::HEAD)
        && req.headers().get(header::ACCEPT).and_then(|v| v.to_str().ok()).is_some_and(|a| a.contains("text/html"))
        && !["/api/", "/proxy/", "/net/"].iter().any(|p| path.starts_with(p))
        && path != "/ws";
    if wants_html {
        return login_page(StatusCode::UNAUTHORIZED, None);
    }
    let mut res = (
        StatusCode::UNAUTHORIZED,
        [(header::CONTENT_TYPE, "application/json")],
        r#"{"error":{"code":"UNAUTHENTICATED","message":"Sign in to Orion OS first."}}"#,
    )
        .into_response();
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

/// `GET /login`
pub async fn login_form(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    match &state.gate {
        Some(gate) if gate.session(&headers).is_none() => login_page(StatusCode::OK, None),
        _ => see_other("/"),
    }
}

/// `POST /login` — form body `key=…`.
pub async fn login(State(state): State<SharedState>, req: Request) -> Response {
    let Some(gate) = &state.gate else {
        return see_other("/");
    };
    let ip: IpAddr = crate::web::limit::client_ip(&req, gate.trust_proxy_headers);
    let same_origin = crate::hosts::is_same_origin_request(&state.hosts, req.uri(), req.headers());
    // Read the (≤ 4 KiB) body before answering, even when refusing: replying
    // mid-upload makes streaming proxies (e.g. Caddy) report 502.
    let (key, remember) = read_form(req).await;
    if !same_origin {
        tracing::warn!(%ip, "sign-in refused: missing or cross-origin Origin");
        return (StatusCode::FORBIDDEN, "cross-origin sign-in refused").into_response();
    }
    if !gate.per_client.check(ip) || !gate.global.check(IpAddr::from([0, 0, 0, 0])) {
        tracing::warn!(%ip, "sign-in rate limited");
        return login_page(StatusCode::TOO_MANY_REQUESTS, Some("Too many attempts. Wait a minute and try again."));
    }
    let Some(key) = key else {
        return login_page(StatusCode::BAD_REQUEST, Some("Enter the access key."));
    };
    if !gate.key_matches(&key) {
        tracing::warn!(%ip, "sign-in failed: wrong access key");
        return login_page(StatusCode::UNAUTHORIZED, Some("That access key isn’t right."));
    }
    tracing::info!(%ip, remember, "signed in");
    let cookie = if remember {
        gate.set_cookie(&gate.issue(gate.ttl.as_secs()), Some(gate.ttl.as_secs()))
    } else {
        gate.set_cookie(&gate.issue(BROWSER_SESSION_SECS.min(gate.ttl.as_secs())), None)
    };
    let mut res = see_other("/");
    res.headers_mut().insert(header::SET_COOKIE, cookie);
    res
}

/// `POST /logout` — same-origin only; revokes the session and clears the
/// cookie. `?erase=1` also asks the browser to delete Orion OS's local data.
pub async fn logout(State(state): State<SharedState>, req: Request) -> Response {
    let Some(gate) = &state.gate else {
        return StatusCode::NO_CONTENT.into_response();
    };
    if !crate::hosts::is_same_origin_request(&state.hosts, req.uri(), req.headers()) {
        return (StatusCode::FORBIDDEN, "cross-origin sign-out refused").into_response();
    }
    if let Some(s) = gate.session(req.headers()) {
        gate.revoke(&s);
        tracing::info!("signed out");
    }
    let erase = req.uri().query().is_some_and(|q| q.split('&').any(|p| p == "erase=1"));
    let mut res = StatusCode::NO_CONTENT.into_response();
    res.headers_mut().insert(header::SET_COOKIE, gate.set_cookie("", Some(0)));
    if erase {
        // Not "cookies": that would clear every cookie for the host, and ours is already expired above.
        res.headers_mut().insert("clear-site-data", HeaderValue::from_static("\"cache\", \"storage\""));
    }
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

/// `GET /api/session` — whether the access gate is on (Settings shows
/// "Sign out" only then). Behind the gate, so reaching it means signed in.
pub async fn session_info(State(state): State<SharedState>) -> Response {
    let body = if state.gate.is_some() { r#"{"access_control":true}"# } else { r#"{"access_control":false}"# };
    ([(header::CACHE_CONTROL, "no-store"), (header::CONTENT_TYPE, "application/json")], body).into_response()
}

/// `GET /healthz` — liveness for the reverse proxy / monitoring. No session
/// needed and nothing revealed beyond "the process answers".
pub async fn healthz() -> Response {
    ([(header::CACHE_CONTROL, "no-store"), (header::CONTENT_TYPE, "text/plain")], "ok").into_response()
}

/// Read `key` and the "keep me signed in" box from an
/// `application/x-www-form-urlencoded` body (max 4 KiB).
async fn read_form(req: Request) -> (Option<String>, bool) {
    let is_form = req
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|t| t.starts_with("application/x-www-form-urlencoded"));
    let Ok(bytes) = axum::body::to_bytes(req.into_body(), 4 * 1024).await else {
        return (None, false);
    };
    if !is_form {
        return (None, false);
    }
    let mut key = None;
    let mut remember = false;
    for (k, v) in url::form_urlencoded::parse(&bytes) {
        match &*k {
            "key" if !v.is_empty() => key = Some(v.into_owned()),
            "remember" => remember = v == "1",
            _ => {}
        }
    }
    (key, remember)
}

fn see_other(to: &'static str) -> Response {
    let mut res = (StatusCode::SEE_OTHER, [(header::LOCATION, to)]).into_response();
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

/// Self-contained sign-in page: inline styles only, no scripts, cannot be
/// framed, never cached. `error` is always one of the fixed strings above.
fn login_page(status: StatusCode, error: Option<&'static str>) -> Response {
    let error = error.map(|e| format!(r#"<p class="err" role="alert">{e}</p>"#)).unwrap_or_default();
    let html = format!(
        r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Sign in · Orion OS</title>
<style>
:root{{color-scheme:dark light;--bg:#0f1117;--card:#181b24;--fg:#e8eaf0;--muted:#9aa0ae;--line:#2a2e3a;--accent:#6b8cff;--err:#ff7a7a}}
@media (prefers-color-scheme:light){{:root{{--bg:#eef0f5;--card:#fff;--fg:#151821;--muted:#5b6170;--line:#d7dae3;--accent:#3355dd;--err:#c62828}}}}
*{{box-sizing:border-box}}body{{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;padding:16px}}
form{{width:100%;max-width:360px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}}
h1{{margin:0 0 4px;font-size:22px}}p{{margin:0 0 20px;color:var(--muted)}}label{{display:block;font-weight:600;margin-bottom:6px}}
input{{width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);font:inherit}}
button{{margin-top:16px;width:100%;padding:10px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}}
.err{{color:var(--err);margin:12px 0 0}}
.check{{display:flex;gap:8px;align-items:center;font-weight:400;margin:14px 0 2px}}.check input{{width:auto}}small{{color:var(--muted);display:block}}
</style></head><body>
<form method="post" action="/login">
<h1>Orion OS</h1><p>Enter the access key to continue.</p>
<input type="text" name="username" value="orion" autocomplete="username" hidden>
<label for="key">Access key</label>
<input id="key" name="key" type="password" autocomplete="current-password" required autofocus maxlength="{MAX_KEY_LEN}">
<label class="check"><input type="checkbox" name="remember" value="1"> Keep me signed in on this device</label>
<small>Leave unticked on shared or school computers: you'll be signed out when the browser closes.</small>
{error}<button type="submit">Sign in</button>
</form></body></html>"#
    );
    let mut res = (status, [(header::CONTENT_TYPE, "text/html; charset=utf-8")], html).into_response();
    let h = res.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"),
    );
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    // `same-origin`, not `no-referrer`: the latter makes browsers send
    // `Origin: null` on the form POST, which the sign-in Origin check refuses.
    h.insert(header::REFERRER_POLICY, HeaderValue::from_static("same-origin"));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gate() -> Gate {
        let mut c = Config::from_env();
        c.mode = crate::config::Mode::Production;
        c.access_key = Some(crate::config::Secret::new("unit-test-access-key-123".into()));
        Gate::from_config(&c).unwrap()
    }

    fn sign(g: &Gate, body: &str) -> String {
        format!("{body}.{}", URL_SAFE_NO_PAD.encode(hmac::sign(&g.session_key, body.as_bytes()).as_ref()))
    }

    #[test]
    fn issued_tokens_verify_and_expired_ones_do_not() {
        let g = gate();
        assert!(g.verify(&g.issue(3600)).is_some());
        // Correctly signed but expired a second ago.
        assert!(g.verify(&sign(&g, &format!("v1.{}.bm9uY2U", now() - 1))).is_none());
        // Correctly signed but malformed shapes.
        for body in ["v2.99999999999.bm9uY2U", "v1.notanumber.bm9uY2U", "v1.99999999999", "v1.99999999999.a.b"] {
            assert!(g.verify(&sign(&g, body)).is_none(), "{body}");
        }
    }

    #[test]
    fn key_comparison_is_exact() {
        let g = gate();
        assert!(g.key_matches("unit-test-access-key-123"));
        for k in ["", "unit-test-access-key-12", "unit-test-access-key-1234", "UNIT-TEST-ACCESS-KEY-123", " unit-test-access-key-123"] {
            assert!(!g.key_matches(k), "{k:?}");
        }
        assert!(!g.key_matches(&"x".repeat(MAX_KEY_LEN + 1)));
    }

    #[test]
    fn nonces_are_unique() {
        let g = gate();
        let a = g.verify(&g.issue(3600)).unwrap();
        let b = g.verify(&g.issue(3600)).unwrap();
        assert_ne!(a.nonce, b.nonce);
    }
}
