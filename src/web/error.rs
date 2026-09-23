//! Error codes for the web layer. The same code strings are used by the
//! frontend error screens (static/js/core/frame.js → ERRORS), so an error
//! raised here renders as a native LTF OS screen in the app window.

use axum::{
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Code {
    InvalidUrl,
    BlockedRequest,
    EmbeddingNotAllowed,
    NetworkTimeout,
    SiteUnavailable,
    ProxyError,
    ProxyDisabled,
    ServerError,
    UnsupportedContent,
    RateLimited,
    TooLarge,
}

impl Code {
    pub fn as_str(self) -> &'static str {
        match self {
            Code::InvalidUrl => "INVALID_URL",
            Code::BlockedRequest => "BLOCKED_REQUEST",
            Code::EmbeddingNotAllowed => "EMBEDDING_NOT_ALLOWED",
            Code::NetworkTimeout => "NETWORK_TIMEOUT",
            Code::SiteUnavailable => "SITE_UNAVAILABLE",
            Code::ProxyError => "PROXY_ERROR",
            Code::ProxyDisabled => "PROXY_DISABLED",
            Code::ServerError => "SERVER_ERROR",
            Code::UnsupportedContent => "UNSUPPORTED_CONTENT",
            Code::RateLimited => "RATE_LIMITED",
            Code::TooLarge => "TOO_LARGE",
        }
    }

    pub fn status(self) -> StatusCode {
        match self {
            Code::InvalidUrl => StatusCode::BAD_REQUEST,
            Code::BlockedRequest | Code::EmbeddingNotAllowed | Code::ProxyDisabled => StatusCode::FORBIDDEN,
            Code::NetworkTimeout => StatusCode::GATEWAY_TIMEOUT,
            Code::SiteUnavailable | Code::ProxyError => StatusCode::BAD_GATEWAY,
            Code::ServerError => StatusCode::INTERNAL_SERVER_ERROR,
            Code::UnsupportedContent => StatusCode::UNSUPPORTED_MEDIA_TYPE,
            Code::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            Code::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
        }
    }

    fn title(self) -> &'static str {
        match self {
            Code::InvalidUrl => "Invalid address",
            Code::BlockedRequest => "This address is blocked",
            Code::EmbeddingNotAllowed => "This site can’t be shown in an app window",
            Code::NetworkTimeout => "The site took too long to respond",
            Code::SiteUnavailable => "Site unavailable",
            Code::ProxyError => "Unable to load content",
            Code::ProxyDisabled => "Content proxy disabled",
            Code::ServerError => "Something went wrong",
            Code::UnsupportedContent => "Unsupported content",
            Code::RateLimited => "Too many requests",
            Code::TooLarge => "Content too large",
        }
    }
}

/// A web-layer failure with a stable code and a human-readable message.
#[derive(Debug, Clone)]
pub struct WebError {
    pub code: Code,
    pub message: String,
}

impl WebError {
    pub fn new(code: Code, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    /// Map a reqwest failure to the closest code, keeping the cause chain.
    pub fn from_reqwest(host: &str, e: &reqwest::Error) -> Self {
        let code = if e.is_timeout() { Code::NetworkTimeout } else if e.is_connect() { Code::SiteUnavailable } else { Code::ProxyError };
        Self::new(code, format!("{host}: {}", error_chain(e)))
    }

    /// JSON body for API callers (`{ "error": { code, message } }`).
    pub fn json(&self) -> Response {
        (self.code.status(), Json(json!({ "error": { "code": self.code.as_str(), "message": self.message } }))).into_response()
    }

    /// Self-contained HTML error page for iframe navigations (`/proxy/page`).
    /// Styled to match LTF OS; served with a script-free sandbox CSP.
    pub fn html(&self, target: &str) -> Response {
        let page = format!(
            r#"<!doctype html><meta charset="utf-8"><meta name="ltf-error" content="{code}"><title>{title}</title>
<style>html,body{{margin:0;height:100%}}body{{display:grid;place-content:center;justify-items:center;gap:10px;padding:32px;text-align:center;font:14px "Segoe UI",system-ui,sans-serif;background:#16181f;color:#eef0f5}}
.i{{width:56px;height:56px;border-radius:50%;display:grid;place-items:center;background:#f5b94222;color:#f5b942;font-size:28px}}h1{{margin:6px 0 0;font-size:19px;font-weight:600}}p{{margin:0;max-width:460px;color:#b1b6c4;line-height:1.5}}code{{font:12px ui-monospace,monospace;color:#7a8093;word-break:break-all}}</style>
<div class="i">⚠</div><h1>{title}</h1><p>{msg}</p><code>{code} · {target}</code>"#,
            code = self.code.as_str(),
            title = escape(self.code.title()),
            msg = escape(&self.message),
            target = escape(target),
        );
        let mut r = (self.code.status(), [(header::CONTENT_TYPE, "text/html; charset=utf-8")], page).into_response();
        r.headers_mut().insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("sandbox; default-src 'none'; style-src 'unsafe-inline'"));
        r.headers_mut().insert("x-ltf-error", HeaderValue::from_static(self.code.as_str()));
        r
    }
}

impl IntoResponse for WebError {
    fn into_response(self) -> Response {
        self.json()
    }
}

/// "error sending request" alone is useless; include the underlying causes.
pub fn error_chain(e: &dyn std::error::Error) -> String {
    let mut msg = e.to_string();
    let mut src = e.source();
    while let Some(s) = src {
        msg.push_str(": ");
        msg.push_str(&s.to_string());
        src = s.source();
    }
    msg
}

pub fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;").replace('>', "&gt;")
}
