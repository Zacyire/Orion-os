//! `GET /proxy/page?url=` — *isolated* document mode (Orion "Isolated" and
//! web-apps with `"proxy": "isolated"`).
//!
//! The server fetches the page and returns it with:
//! * `Content-Security-Policy: sandbox …` **without** `allow-same-origin` —
//!   the page runs in an opaque origin, so it can't read Orion OS storage,
//!   cookies or API responses, and no site cookies exist to leak;
//! * an injected `<base href>` so subresources load straight from the origin
//!   (they are not proxied — cheaper and faithful);
//! * a small script that routes link clicks / GET forms back through this
//!   endpoint and reports navigation + title to the owning window.
//!
//! Framing policy is enforced *here too*: a page that forbids embedding is
//! answered with an EMBEDDING_NOT_ALLOWED screen, never rendered. Because
//! the document is re-hosted, the site's own CSP (whose `'self'` would now
//! mean the Orion OS origin) is replaced by the stricter sandbox above.

use std::time::Instant;

use axum::{
    body::Body,
    extract::{Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::Response,
};
use futures_util::StreamExt;
use url::Url;

use super::{
    client,
    error::{escape, Code, WebError},
    guard,
    inspect::{truncate, UrlQuery},
    policy,
};
use crate::state::SharedState;

const MAX_HTML_BYTES: usize = 6 * 1024 * 1024;
const MAX_PASSTHROUGH_BYTES: u64 = 32 * 1024 * 1024;
pub const SANDBOX_CSP: &str =
    "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation allow-modals";

pub async fn handler(State(state): State<SharedState>, headers: HeaderMap, Query(q): Query<UrlQuery>) -> Response {
    let started = Instant::now();
    match serve(&state, &headers, &q.url).await {
        Ok((resp, host)) => {
            tracing::info!(target: "ltf_os::web", mode = "page", %host, status = resp.status().as_u16(), ms = started.elapsed().as_millis() as u64, "served");
            resp
        }
        Err(e) => {
            tracing::info!(target: "ltf_os::web", mode = "page", url = %truncate(&q.url), code = e.code.as_str(), "{}", e.message);
            e.html(&q.url)
        }
    }
}

async fn serve(state: &SharedState, headers: &HeaderMap, raw: &str) -> Result<(Response, String), WebError> {
    let cfg = &state.config;
    if !cfg.proxy_enabled {
        return Err(WebError::new(Code::ProxyDisabled, "Isolated page mode is disabled on this server (LTF_PROXY=0)."));
    }
    let target = guard::check(raw, cfg).await?;
    let upstream = client::send(&target, headers, cfg).await?;
    let host = target.host.clone();

    // Redirect → bounce through /proxy/page so the next hop is re-validated
    // and the frame's own URL keeps matching the injected <base>.
    if upstream.status().is_redirection() {
        let next = client::redirect_target(&target.url, &upstream)?;
        let resp = Response::builder()
            .status(StatusCode::FOUND)
            .header(header::LOCATION, page_url(next.as_str()))
            .body(Body::empty())
            .unwrap();
        return Ok((resp, host));
    }

    let frame = policy::evaluate(upstream.headers());
    if !frame.embeddable {
        return Err(WebError::new(
            Code::EmbeddingNotAllowed,
            format!("{host} does not allow its pages to be displayed inside other sites ({}).", frame.blocked_by.unwrap_or("framing policy")),
        ));
    }

    let status = upstream.status();
    let ctype = upstream.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("application/octet-stream").to_string();
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
    if let Ok(v) = HeaderValue::from_str(target.url.as_str()) {
        h.insert("x-ltf-proxied-url", v);
    }

    if !is_html {
        // Only types a browser can display inline; downloads/archives/executables are refused.
        let displayable = ["image/", "video/", "audio/", "text/plain", "application/pdf", "application/json"].iter().any(|p| ctype.starts_with(p));
        if !displayable {
            return Err(WebError::new(Code::UnsupportedContent, format!("{ctype} can’t be displayed in an app window. Open it in a browser tab to download it.")));
        }
        if upstream.content_length().is_some_and(|n| n > MAX_PASSTHROUGH_BYTES) {
            return Err(WebError::new(Code::TooLarge, "This resource is too large to display."));
        }
        let mut seen: u64 = 0;
        let stream = upstream.bytes_stream().map(move |chunk| {
            let chunk = chunk.map_err(std::io::Error::other)?;
            seen += chunk.len() as u64;
            if seen > MAX_PASSTHROUGH_BYTES {
                return Err(std::io::Error::other("size limit exceeded"));
            }
            Ok(chunk)
        });
        return Ok((builder.body(Body::from_stream(stream)).unwrap(), host));
    }

    let mut body = Vec::new();
    let mut stream = upstream.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| WebError::from_reqwest(&host, &e))?;
        if body.len() + chunk.len() > MAX_HTML_BYTES {
            return Err(WebError::new(Code::TooLarge, "This page is larger than 6 MB."));
        }
        body.extend_from_slice(&chunk);
    }
    let html = rewrite_html(&String::from_utf8_lossy(&body), &target.url);
    Ok((builder.body(Body::from(html)).unwrap(), host))
}

pub fn page_url(target: &str) -> String {
    format!("/proxy/page?url={}", url::form_urlencoded::byte_serialize(target.as_bytes()).collect::<String>())
}

/// Inject `<base>` (so relative assets load straight from the origin) and a
/// small navigation shim; neutralise `<meta>` CSP / frame policies.
fn rewrite_html(html: &str, url: &Url) -> String {
    let neutralised = neutralise_meta_policies(html);
    let lower = neutralised.to_ascii_lowercase();
    let inject = format!(
        "<base href=\"{base}\"><script>{shim}</script>",
        base = escape(url.as_str()),
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
// location reflects the /proxy URL (unaffected by <base>), so this is the Orion OS server.
var SELF=location.protocol+'//'+location.host;
function prox(u){return SELF+'/proxy/page?url='+encodeURIComponent(u)}
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


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injects_base_and_neutralises_meta_csp() {
        let url = Url::parse("https://example.com/dir/page").unwrap();
        let out = rewrite_html(r#"<html><HEAD><meta http-equiv="Content-Security-Policy" content="x"></head><body></body></html>"#, &url);
        assert!(out.contains(r#"<HEAD><base href="https://example.com/dir/page">"#));
        assert!(out.contains("data-ltf-removed"));
        assert!(out.contains("/proxy/page?url="));
    }
}
