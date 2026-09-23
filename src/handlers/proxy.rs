//! `/proxy?url=…` — fetches a public web page server-side so the Orion
//! browser (and any app with `proxy: true`) can frame sites that send
//! `X-Frame-Options` / `frame-ancestors`.
//!
//! Security model:
//! * **SSRF guard** — only http(s); the host is resolved once, every address
//!   must be public, and the connection is pinned to the validated address
//!   (no DNS rebinding). Redirects are not followed internally; each hop comes
//!   back through `/proxy` and is validated again.
//! * **Origin isolation** — responses carry `Content-Security-Policy: sandbox`
//!   (without `allow-same-origin`), so proxied pages run in an opaque origin
//!   and cannot read LTF OS storage or call its API with credentials.
//! * No cookies are forwarded in either direction; logins won't persist.
//! * Optional host allowlist (`LTF_PROXY_ALLOW`), size caps, timeouts.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use axum::{
    body::Body,
    extract::{Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use serde::Deserialize;
use url::Url;

use crate::state::SharedState;

const MAX_HTML_BYTES: usize = 6 * 1024 * 1024;
const MAX_PASSTHROUGH_BYTES: u64 = 32 * 1024 * 1024;
const SANDBOX_CSP: &str =
    "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation allow-modals";

#[derive(Deserialize)]
pub struct ProxyQuery {
    pub url: String,
}

pub async fn proxy(State(state): State<SharedState>, headers: HeaderMap, Query(q): Query<ProxyQuery>) -> Response {
    match fetch(&state, &headers, &q.url).await {
        Ok(resp) => resp,
        Err((status, msg)) => error_page(status, &q.url, &msg),
    }
}

type ProxyResult<T> = Result<T, (StatusCode, String)>;

async fn fetch(state: &SharedState, client_headers: &HeaderMap, raw: &str) -> ProxyResult<Response> {
    let cfg = &state.config;
    if !cfg.proxy_enabled {
        return Err((StatusCode::FORBIDDEN, "The content proxy is disabled on this server.".into()));
    }
    let url = parse_target(raw)?;
    let host = url.host_str().unwrap_or_default().to_lowercase();
    if !host_allowed(&host, &cfg.proxy_allow) {
        return Err((StatusCode::FORBIDDEN, format!("{host} is not on this server's proxy allowlist.")));
    }
    let addr = resolve_public(&url, cfg.proxy_allow_private).await?;

    // Pin the connection to the address we just validated.
    let client = reqwest::Client::builder()
        .user_agent(browser_ua(client_headers))
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .resolve(&host, addr)
        .build()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let mut req = client.get(url.clone());
    for name in [header::ACCEPT, header::ACCEPT_LANGUAGE] {
        if let Some(v) = client_headers.get(&name) {
            req = req.header(name, v.clone());
        }
    }
    let upstream = req.send().await.map_err(|e| (StatusCode::BAD_GATEWAY, format!("Could not reach {host}: {}", error_chain(&e))))?;
    let status = upstream.status();

    // Redirect → bounce back through the proxy so the next hop is validated too.
    if status.is_redirection() {
        if let Some(loc) = upstream.headers().get(header::LOCATION).and_then(|v| v.to_str().ok()) {
            let next = url.join(loc).map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;
            return Ok(Response::builder()
                .status(StatusCode::FOUND)
                .header(header::LOCATION, proxied_url(next.as_str()))
                .body(Body::empty())
                .unwrap());
        }
    }

    let ctype = upstream
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let is_html = ctype.starts_with("text/html") || ctype.starts_with("application/xhtml");

    let mut builder = Response::builder().status(status);
    let h = builder.headers_mut().unwrap();
    for name in [header::CACHE_CONTROL, header::LAST_MODIFIED, header::ETAG, header::CONTENT_LANGUAGE] {
        if let Some(v) = upstream.headers().get(&name) {
            h.insert(name, v.clone());
        }
    }
    h.insert(header::CONTENT_TYPE, HeaderValue::from_str(&ctype).unwrap_or(HeaderValue::from_static("text/plain")));
    h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(SANDBOX_CSP));
    h.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    h.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    if let Ok(v) = HeaderValue::from_str(url.as_str()) {
        h.insert("x-ltf-proxied-url", v);
    }

    if !is_html {
        if upstream.content_length().is_some_and(|n| n > MAX_PASSTHROUGH_BYTES) {
            return Err((StatusCode::PAYLOAD_TOO_LARGE, "Resource is too large to proxy.".into()));
        }
        let mut seen: u64 = 0;
        let stream = upstream.bytes_stream().map(move |chunk| {
            let chunk = chunk.map_err(std::io::Error::other)?;
            seen += chunk.len() as u64;
            if seen > MAX_PASSTHROUGH_BYTES {
                return Err(std::io::Error::other("proxy size limit exceeded"));
            }
            Ok(chunk)
        });
        return Ok(builder.body(Body::from_stream(stream)).unwrap());
    }

    let mut body = Vec::new();
    let mut stream = upstream.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;
        if body.len() + chunk.len() > MAX_HTML_BYTES {
            return Err((StatusCode::PAYLOAD_TOO_LARGE, "Page is too large to proxy.".into()));
        }
        body.extend_from_slice(&chunk);
    }
    let html = rewrite_html(&String::from_utf8_lossy(&body), &url);
    Ok(builder.body(Body::from(html)).unwrap())
}

/// `/api/frame-check?url=…` — reports whether a page may be framed directly
/// (inspects `X-Frame-Options` and CSP `frame-ancestors`) so the UI can switch
/// to the proxy or offer "open in new tab" instead of showing a blank frame.
pub async fn frame_check(State(state): State<SharedState>, headers: HeaderMap, Query(q): Query<ProxyQuery>) -> Response {
    let result: ProxyResult<serde_json::Value> = async {
        let url = parse_target(&q.url)?;
        let host = url.host_str().unwrap_or_default().to_lowercase();
        let addr = resolve_public(&url, state.config.proxy_allow_private).await?;
        let client = reqwest::Client::builder()
            .user_agent(browser_ua(&headers))
            .timeout(std::time::Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .resolve(&host, addr)
            .build()
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        let resp = client.get(url.clone()).send().await.map_err(|e| (StatusCode::BAD_GATEWAY, error_chain(&e)))?;
        let xfo = resp.headers().get("x-frame-options").and_then(|v| v.to_str().ok()).map(str::to_lowercase);
        let csp = resp.headers().get(header::CONTENT_SECURITY_POLICY).and_then(|v| v.to_str().ok()).map(str::to_lowercase);
        let redirect = resp.status().is_redirection();
        let blocked_by = if xfo.as_deref().is_some_and(|v| v.contains("deny") || v.contains("sameorigin")) {
            Some("X-Frame-Options")
        } else if csp.as_deref().is_some_and(frame_ancestors_blocks) {
            Some("Content-Security-Policy frame-ancestors")
        } else {
            None
        };
        Ok(serde_json::json!({
            "url": url.as_str(),
            "status": resp.status().as_u16(),
            "embeddable": blocked_by.is_none(),
            "blocked_by": blocked_by,
            "redirect": redirect,
            "proxy_available": state.config.proxy_enabled && host_allowed(&host, &state.config.proxy_allow),
        }))
    }
    .await;
    match result {
        Ok(v) => axum::Json(v).into_response(),
        Err((status, msg)) => (status, axum::Json(serde_json::json!({ "error": msg }))).into_response(),
    }
}

/// A `frame-ancestors` directive blocks us unless it contains `*`.
fn frame_ancestors_blocks(csp: &str) -> bool {
    csp.split(';')
        .map(str::trim)
        .find_map(|d| d.strip_prefix("frame-ancestors"))
        .is_some_and(|srcs| !srcs.split_whitespace().any(|s| s == "*"))
}

/// "error sending request" alone is useless; include the underlying causes.
fn error_chain(e: &dyn std::error::Error) -> String {
    let mut msg = e.to_string();
    let mut src = e.source();
    while let Some(s) = src {
        msg.push_str(": ");
        msg.push_str(&s.to_string());
        src = s.source();
    }
    msg
}

fn parse_target(raw: &str) -> ProxyResult<Url> {
    let url = Url::parse(raw.trim()).map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid URL: {e}")))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err((StatusCode::BAD_REQUEST, "Only http and https URLs can be proxied.".into()));
    }
    if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err((StatusCode::BAD_REQUEST, "URL must have a host and no credentials.".into()));
    }
    Ok(url)
}

fn host_allowed(host: &str, allow: &[String]) -> bool {
    allow.is_empty() || allow.iter().any(|d| host == d || host.ends_with(&format!(".{d}")))
}

async fn resolve_public(url: &Url, allow_private: bool) -> ProxyResult<SocketAddr> {
    let host = url.host_str().unwrap_or_default().trim_start_matches('[').trim_end_matches(']').to_string();
    let port = url.port_or_known_default().unwrap_or(443);
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("DNS lookup failed for {host}: {e}")))?
        .collect();
    if addrs.is_empty() {
        return Err((StatusCode::BAD_GATEWAY, format!("{host} did not resolve.")));
    }
    if let Some(bad) = addrs.iter().find(|a| !allow_private && !is_public(a.ip())) {
        return Err((StatusCode::FORBIDDEN, format!("{host} resolves to a non-public address ({}).", bad.ip())));
    }
    Ok(addrs[0])
}

/// True only for globally routable unicast addresses.
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public_v4(v4);
            }
            let seg0 = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (seg0 & 0xfe00) == 0xfc00 // unique local
                || (seg0 & 0xffc0) == 0xfe80 // link local
                || seg0 == 0x2001 && v6.segments()[1] == 0x0db8) // documentation
        }
    }
}

fn is_public_v4(v4: Ipv4Addr) -> bool {
    let o = v4.octets();
    !(v4.is_private()
        || v4.is_loopback()
        || v4.is_link_local()
        || v4.is_broadcast()
        || v4.is_documentation()
        || v4.is_unspecified()
        || v4.is_multicast()
        || o[0] == 0
        || (o[0] == 100 && (o[1] & 0xc0) == 64) // CGNAT 100.64/10
        || (o[0] == 192 && o[1] == 0 && o[2] == 0) // IETF protocol assignments
        || (o[0] == 198 && (o[1] & 0xfe) == 18) // benchmarking 198.18/15
        || o[0] >= 240)
}

fn browser_ua(h: &HeaderMap) -> String {
    h.get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(String::from)
        .unwrap_or_else(|| "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36".into())
}

pub fn proxied_url(target: &str) -> String {
    format!("/proxy?url={}", url::form_urlencoded::byte_serialize(target.as_bytes()).collect::<String>())
}

fn escape_attr(s: &str) -> String {
    s.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Inject `<base>` (so relative assets load straight from the origin) and a
/// small navigation shim; neutralise `<meta>` CSP / frame policies.
fn rewrite_html(html: &str, url: &Url) -> String {
    let neutralised = neutralise_meta_policies(html);
    let lower = neutralised.to_ascii_lowercase();
    let inject = format!(
        "<base href=\"{base}\"><script>{shim}</script>",
        base = escape_attr(url.as_str()),
        shim = SHIM.replace("__LTF_URL__", &serde_json::to_string(url.as_str()).unwrap_or_default()),
    );
    let insert_at = lower
        .find("<head")
        .and_then(|i| lower[i..].find('>').map(|j| i + j + 1))
        .unwrap_or(0);
    let mut out = String::with_capacity(neutralised.len() + inject.len());
    out.push_str(&neutralised[..insert_at]);
    out.push_str(&inject);
    out.push_str(&neutralised[insert_at..]);
    out
}

/// Rename `http-equiv` on `<meta>` CSP / X-Frame-Options tags so browsers ignore them.
fn neutralise_meta_policies(html: &str) -> String {
    const ATTR: &str = "http-equiv";
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len());
    let mut cursor = 0;
    while let Some(pos) = lower[cursor..].find(ATTR) {
        let at = cursor + pos;
        let window = &lower[at..(at + 64).min(lower.len())];
        let policy = window.contains("content-security-policy") || window.contains("x-frame-options");
        out.push_str(&html[cursor..at]);
        out.push_str(if policy { "data-ltf-removed" } else { &html[at..at + ATTR.len()] });
        cursor = at + ATTR.len();
    }
    out.push_str(&html[cursor..]);
    out
}

/// Runs inside the proxied page (opaque origin). Routes link clicks and GET
/// forms back through the proxy and reports navigation to the Orion window.
const SHIM: &str = r#"(function(){
var PAGE=__LTF_URL__;
// location reflects the /proxy URL (unaffected by <base>), so this is the LTF server.
var SELF=location.protocol+'//'+location.host;
function prox(u){return SELF+'/proxy?url='+encodeURIComponent(u)}
function abs(h){try{return new URL(h,document.baseURI).href}catch(e){return null}}
function tell(t,d){try{parent.postMessage(Object.assign({source:'ltf-proxy',type:t},d),'*')}catch(e){}}
function go(u){location.href=prox(u)}
document.addEventListener('click',function(e){
  var a=e.target.closest&&e.target.closest('a[href]');if(!a||e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey)return;
  var u=abs(a.getAttribute('href'));if(!u||!/^https?:/i.test(u))return;
  if(u.split('#')[0]===PAGE.split('#')[0]&&u.indexOf('#')>-1)return;
  e.preventDefault();
  if(a.target==='_blank'){tell('open',{url:u});return}
  go(u);
},true);
document.addEventListener('submit',function(e){
  var f=e.target;if((f.method||'get').toLowerCase()!=='get')return;
  var u=abs(f.getAttribute('action')||PAGE);if(!u)return;e.preventDefault();
  var q=new URLSearchParams(new FormData(f)).toString();var x=new URL(u);x.search=q;go(x.href);
},true);
tell('navigate',{url:PAGE});
addEventListener('DOMContentLoaded',function(){tell('title',{url:PAGE,title:document.title})});
})();"#;

fn error_page(status: StatusCode, target: &str, msg: &str) -> Response {
    let html = format!(
        r#"<!doctype html><meta charset="utf-8"><title>Unable to load page</title>
<style>body{{margin:0;height:100vh;display:grid;place-content:center;gap:10px;font:14px system-ui,sans-serif;background:#111318;color:#e6e8ee;text-align:center;padding:24px}}h1{{font-size:20px;margin:0}}p{{color:#9aa0ad;max-width:520px;margin:0 auto}}code{{color:#7fb0ff;word-break:break-all}}</style>
<h1>This page can’t be displayed</h1><p>{msg}</p><p><code>{target}</code></p><p>HTTP {code}</p>"#,
        msg = escape_attr(msg),
        target = escape_attr(target),
        code = status.as_u16()
    );
    let mut r = (status, [(header::CONTENT_TYPE, "text/html; charset=utf-8")], html).into_response();
    r.headers_mut().insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(SANDBOX_CSP));
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_internal_addresses() {
        for ip in ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"] {
            assert!(!is_public(ip.parse().unwrap()), "{ip} should be blocked");
        }
        for ip in ["1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"] {
            assert!(is_public(ip.parse().unwrap()), "{ip} should be allowed");
        }
    }

    #[test]
    fn rejects_bad_targets() {
        assert!(parse_target("file:///etc/passwd").is_err());
        assert!(parse_target("http://user:pw@example.com").is_err());
        assert!(parse_target("javascript:alert(1)").is_err());
        assert!(parse_target("https://example.com/a?b=c").is_ok());
    }

    #[test]
    fn frame_ancestors_parsing() {
        assert!(frame_ancestors_blocks("default-src 'self'; frame-ancestors 'self'"));
        assert!(frame_ancestors_blocks("frame-ancestors 'none'"));
        assert!(!frame_ancestors_blocks("frame-ancestors *"));
        assert!(!frame_ancestors_blocks("default-src 'self'"));
    }

    #[test]
    fn allowlist_suffix_match() {
        let allow = vec!["wikipedia.org".to_string()];
        assert!(host_allowed("en.wikipedia.org", &allow));
        assert!(host_allowed("wikipedia.org", &allow));
        assert!(!host_allowed("evilwikipedia.org", &allow));
        assert!(host_allowed("anything.com", &[]));
    }

    #[test]
    fn injects_base_and_strips_meta_csp() {
        let url = Url::parse("https://example.com/dir/page").unwrap();
        let out = rewrite_html(r#"<html><HEAD><meta http-equiv="Content-Security-Policy" content="x"></head><body></body></html>"#, &url);
        assert!(out.contains(r#"<HEAD><base href="https://example.com/dir/page">"#));
        assert!(out.contains("data-ltf-removed"));
        assert!(!out.to_lowercase().contains("http-equiv=\"content-security-policy\""));
    }
}
