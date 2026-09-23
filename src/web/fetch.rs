//! Resource fetching — the `/net/` namespace.
//!
//! `GET /net/<percent-encoded absolute URL>` (and the equivalent
//! `GET /proxy/fetch?url=`) returns a remote resource from the LTF OS
//! origin. It exists for data the browser can't read cross-origin because
//! of the same-origin policy: JSON/XML APIs and feeds, images drawn into a
//! canvas, favicons and thumbnails the service worker caches, media byte
//! ranges. It is a plain server-side GET — equivalent to a feed reader:
//!
//! * GET/HEAD only, no request body, no cookies/credentials forwarded;
//! * redirects followed server-side, each hop re-validated (guard.rs);
//! * `Range` / conditional headers forwarded so media seeking and caching work;
//! * response headers allowlisted; `Set-Cookie` and security headers of the
//!   remote site are not relayed;
//! * responses are served with `Content-Security-Policy: sandbox` and
//!   `X-Content-Type-Options: nosniff`, so fetched HTML/SVG can never run
//!   script in the LTF OS origin, and `Cross-Origin-Resource-Policy:
//!   same-origin`, so other websites can't hotlink this server as a proxy.

use std::time::Instant;

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderName, HeaderValue},
    response::Response,
};
use futures_util::StreamExt;

use super::{
    client,
    error::{Code, WebError},
    guard,
    inspect::{truncate, UrlQuery},
};
use crate::state::SharedState;

pub const MAX_BYTES: u64 = 32 * 1024 * 1024;

const RELAY_RESPONSE_HEADERS: &[HeaderName] = &[
    header::CONTENT_TYPE,
    header::CONTENT_LENGTH,
    header::CONTENT_RANGE,
    header::ACCEPT_RANGES,
    header::CACHE_CONTROL,
    header::ETAG,
    header::LAST_MODIFIED,
    header::EXPIRES,
    header::CONTENT_LANGUAGE,
];

/// `/proxy/fetch?url=…`
pub async fn by_query(State(state): State<SharedState>, headers: HeaderMap, Query(q): Query<UrlQuery>) -> Response {
    respond(&state, &headers, &q.url).await
}

/// `/net/<encoded-url>` — the path segment is percent-decoded by the router.
pub async fn by_path(State(state): State<SharedState>, headers: HeaderMap, Path(target): Path<String>) -> Response {
    respond(&state, &headers, &target).await
}

async fn respond(state: &SharedState, headers: &HeaderMap, raw: &str) -> Response {
    let started = Instant::now();
    match fetch(state, headers, raw).await {
        Ok((resp, host)) => {
            tracing::info!(target: "ltf_os::web", mode = "fetch", %host, status = resp.status().as_u16(), ms = started.elapsed().as_millis() as u64, "fetched");
            resp
        }
        Err(e) => {
            tracing::info!(target: "ltf_os::web", mode = "fetch", url = %truncate(raw), code = e.code.as_str(), "{}", e.message);
            let mut r = e.json();
            r.headers_mut().insert("x-ltf-error", HeaderValue::from_static(e.code.as_str()));
            r
        }
    }
}

async fn fetch(state: &SharedState, headers: &HeaderMap, raw: &str) -> Result<(Response, String), WebError> {
    let cfg = &state.config;
    if !cfg.proxy_enabled {
        return Err(WebError::new(Code::ProxyDisabled, "Remote fetching is disabled on this server (LTF_PROXY=0)."));
    }
    let target = guard::check(raw, cfg).await?;
    let (final_target, upstream) = client::get_following(target, headers, cfg).await?;
    if upstream.content_length().is_some_and(|n| n > MAX_BYTES) {
        return Err(WebError::new(Code::TooLarge, "Resource exceeds the 32 MB limit."));
    }

    let mut builder = Response::builder().status(upstream.status());
    let h = builder.headers_mut().unwrap();
    for name in RELAY_RESPONSE_HEADERS {
        if let Some(v) = upstream.headers().get(name) {
            h.insert(name, v.clone());
        }
    }
    h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'"));
    h.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    h.insert("cross-origin-resource-policy", HeaderValue::from_static("same-origin"));
    h.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    if let Ok(v) = HeaderValue::from_str(final_target.url.as_str()) {
        h.insert("x-ltf-final-url", v);
    }

    let mut seen: u64 = 0;
    let stream = upstream.bytes_stream().map(move |chunk| {
        let chunk = chunk.map_err(std::io::Error::other)?;
        seen += chunk.len() as u64;
        if seen > MAX_BYTES {
            return Err(std::io::Error::other("size limit exceeded"));
        }
        Ok(chunk)
    });
    Ok((builder.body(Body::from_stream(stream)).unwrap(), final_target.host))
}
