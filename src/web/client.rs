//! Outbound HTTP for the web layer.
//!
//! Every connection is pinned to the address `guard::resolve` validated
//! (`ClientBuilder::resolve`), redirects are never followed automatically,
//! and only an allowlist of request headers is sent. Cookies and
//! credentials are never forwarded in either direction.

use std::time::Duration;

use axum::http::{header, HeaderMap, HeaderName};
use url::Url;

use super::{
    error::{Code, WebError},
    guard::{self, Target},
};
use crate::config::Config;

pub const MAX_REDIRECTS: usize = 5;
pub const TOTAL_TIMEOUT: Duration = Duration::from_secs(20);
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);

/// Request headers copied from the user's browser (everything else is dropped).
pub const FORWARD_REQUEST_HEADERS: &[HeaderName] = &[
    header::ACCEPT,
    header::ACCEPT_LANGUAGE,
    header::RANGE,
    header::IF_NONE_MATCH,
    header::IF_MODIFIED_SINCE,
];

const FALLBACK_UA: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 Orion-OS";

pub fn build(target: &Target, client_headers: &HeaderMap, cfg: &Config) -> Result<reqwest::Client, WebError> {
    let ua = client_headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or(FALLBACK_UA)
        .to_string();
    let mut b = reqwest::Client::builder()
        .user_agent(ua)
        .timeout(TOTAL_TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .resolve(&target.host, target.addr);
    // An environment HTTP proxy would do its own DNS resolution and defeat
    // address pinning, so it is only used when explicitly requested.
    if !cfg.use_env_proxy {
        b = b.no_proxy();
    }
    b.build().map_err(|e| WebError::new(Code::ServerError, e.to_string()))
}

/// GET `target`, following up to MAX_REDIRECTS redirects. Every hop is
/// re-validated by the guard (protocol, port, allowlist, public address).
/// Returns the final target and response (body not yet read).
pub async fn get_following(
    target: Target,
    client_headers: &HeaderMap,
    cfg: &Config,
) -> Result<(Target, reqwest::Response), WebError> {
    let mut current = target;
    for _ in 0..=MAX_REDIRECTS {
        let resp = send(&current, client_headers, cfg).await?;
        if !resp.status().is_redirection() {
            return Ok((current, resp));
        }
        let next = redirect_target(&current.url, &resp)?;
        current = guard::check(next.as_str(), cfg).await?;
    }
    Err(WebError::new(Code::SiteUnavailable, format!("More than {MAX_REDIRECTS} redirects.")))
}

/// A single request without following redirects.
pub async fn send(target: &Target, client_headers: &HeaderMap, cfg: &Config) -> Result<reqwest::Response, WebError> {
    let client = build(target, client_headers, cfg)?;
    let mut req = client.get(target.url.clone());
    for name in FORWARD_REQUEST_HEADERS {
        if let Some(v) = client_headers.get(name) {
            req = req.header(name, v.clone());
        }
    }
    req.send().await.map_err(|e| WebError::from_reqwest(&target.host, &e))
}

pub fn redirect_target(from: &Url, resp: &reqwest::Response) -> Result<Url, WebError> {
    let loc = resp
        .headers()
        .get(header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| WebError::new(Code::ProxyError, "Redirect without a Location header."))?;
    from.join(loc).map_err(|e| WebError::new(Code::ProxyError, format!("Invalid redirect target: {e}")))
}
