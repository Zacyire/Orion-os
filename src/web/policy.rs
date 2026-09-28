//! Embedding policy.
//!
//! A site states whether it may be displayed inside another site with
//! `X-Frame-Options` and/or the CSP `frame-ancestors` directive. Orion OS
//! **respects** both: if either forbids framing by a third party, the page
//! is not shown in an app window (direct iframe or isolated proxy alike) and
//! the UI offers to open it in a normal browser tab instead.

use axum::http::{header, HeaderMap};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct FramePolicy {
    pub embeddable: bool,
    /// Which mechanism forbids embedding, if any.
    pub blocked_by: Option<&'static str>,
}

pub fn evaluate(headers: &HeaderMap) -> FramePolicy {
    // CSP frame-ancestors supersedes X-Frame-Options when both are present.
    let csp: Vec<String> = headers
        .get_all(header::CONTENT_SECURITY_POLICY)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .map(str::to_ascii_lowercase)
        .collect();
    if let Some(sources) = csp.iter().find_map(|p| frame_ancestors(p)) {
        return if sources.iter().any(|s| s == "*") {
            FramePolicy { embeddable: true, blocked_by: None }
        } else {
            // 'self', 'none' or a specific host list: Orion OS is not a permitted ancestor.
            FramePolicy { embeddable: false, blocked_by: Some("Content-Security-Policy frame-ancestors") }
        };
    }
    let xfo = headers.get("x-frame-options").and_then(|v| v.to_str().ok()).map(str::to_ascii_lowercase);
    match xfo.as_deref().map(str::trim) {
        Some(v) if v.contains("deny") || v.contains("sameorigin") || v.starts_with("allow-from") => {
            FramePolicy { embeddable: false, blocked_by: Some("X-Frame-Options") }
        }
        _ => FramePolicy { embeddable: true, blocked_by: None },
    }
}

/// The source list of a `frame-ancestors` directive, if the policy has one.
fn frame_ancestors(policy: &str) -> Option<Vec<String>> {
    policy
        .split(';')
        .map(str::trim)
        .find_map(|d| d.strip_prefix("frame-ancestors"))
        .map(|srcs| srcs.split_whitespace().map(String::from).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn h(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut m = HeaderMap::new();
        for (k, v) in pairs {
            m.append(*k, HeaderValue::from_static(v));
        }
        m
    }

    #[test]
    fn respects_framing_policies() {
        assert!(!evaluate(&h(&[("x-frame-options", "DENY")])).embeddable);
        assert!(!evaluate(&h(&[("x-frame-options", "SAMEORIGIN")])).embeddable);
        assert!(!evaluate(&h(&[("content-security-policy", "default-src 'self'; frame-ancestors 'self'")])).embeddable);
        assert!(!evaluate(&h(&[("content-security-policy", "frame-ancestors https://partner.example")])).embeddable);
        assert!(evaluate(&h(&[("content-security-policy", "frame-ancestors *")])).embeddable);
        assert!(evaluate(&h(&[("content-security-policy", "default-src 'self'")])).embeddable);
        assert!(evaluate(&h(&[])).embeddable);
        // frame-ancestors takes precedence over XFO
        assert!(evaluate(&h(&[("x-frame-options", "DENY"), ("content-security-policy", "frame-ancestors *")])).embeddable);
    }
}
