//! Request guard: everything a URL must pass before the server connects.
//!
//! 1. Syntax & protocol — only absolute `http`/`https` URLs, no embedded
//!    credentials, no fragments sent upstream.
//! 2. Port policy — 80/443 or unprivileged ports (≥1024). Blocks using the
//!    proxy to talk to SMTP, SSH, databases… on public hosts.
//! 3. Host policy — optional allowlist (`LTF_PROXY_ALLOW`) and a fixed
//!    denylist of metadata hostnames.
//! 4. Address policy (SSRF) — the host is resolved once and *every* address
//!    must be globally routable. The connection is then pinned to that
//!    address (client.rs), so a DNS answer can't change between the check
//!    and the connect (DNS rebinding).

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use url::Url;

use super::error::{Code, WebError};
use crate::config::Config;

/// A URL that passed every check, together with the address to connect to.
#[derive(Debug, Clone)]
pub struct Target {
    pub url: Url,
    pub host: String,
    pub addr: SocketAddr,
}

const DENY_HOSTS: &[&str] = &["metadata.google.internal", "metadata", "instance-data", "localhost"];

/// Steps 1–3 (no network access).
pub fn parse(raw: &str, cfg: &Config) -> Result<Url, WebError> {
    let raw = raw.trim();
    if raw.len() > 4096 {
        return Err(WebError::new(Code::InvalidUrl, "URL is longer than 4096 characters."));
    }
    let mut url = Url::parse(raw).map_err(|e| WebError::new(Code::InvalidUrl, format!("Not a valid URL ({e}).")))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(WebError::new(Code::BlockedRequest, format!("The {}: protocol is not supported; only http and https are.", url.scheme())));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(WebError::new(Code::BlockedRequest, "URLs containing credentials are not allowed."));
    }
    let host = url.host_str().map(str::to_ascii_lowercase).ok_or_else(|| WebError::new(Code::InvalidUrl, "URL has no host."))?;
    if DENY_HOSTS.contains(&host.as_str()) || host.ends_with(".localhost") || host.ends_with(".internal") || host.ends_with(".local") {
        return Err(WebError::new(Code::BlockedRequest, format!("{host} is an internal host name.")));
    }
    let port = url.port_or_known_default().unwrap_or(0);
    if !(port == 80 || port == 443 || port >= 1024) {
        return Err(WebError::new(Code::BlockedRequest, format!("Port {port} is not allowed.")));
    }
    if !host_allowed(&host, &cfg.proxy_allow) {
        return Err(WebError::new(Code::BlockedRequest, format!("{host} is not on this server's allowlist.")));
    }
    url.set_fragment(None);
    Ok(url)
}

/// Step 4: resolve and verify every address is public; return a pinnable target.
pub async fn resolve(url: Url, cfg: &Config) -> Result<Target, WebError> {
    let host = url.host_str().unwrap_or_default().trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    let port = url.port_or_known_default().unwrap_or(443);
    let lookup = tokio::time::timeout(std::time::Duration::from_secs(5), tokio::net::lookup_host((host.as_str(), port)))
        .await
        .map_err(|_| WebError::new(Code::NetworkTimeout, format!("DNS lookup for {host} timed out.")))?
        .map_err(|e| WebError::new(Code::SiteUnavailable, format!("{host} could not be resolved ({e}).")))?;
    let addrs: Vec<SocketAddr> = lookup.collect();
    let first = *addrs.first().ok_or_else(|| WebError::new(Code::SiteUnavailable, format!("{host} did not resolve.")))?;
    if !cfg.proxy_allow_private {
        if let Some(bad) = addrs.iter().find(|a| !is_public(a.ip())) {
            tracing::warn!(target: "ltf_os::web", %host, ip = %bad.ip(), "blocked non-public address");
            return Err(WebError::new(Code::BlockedRequest, format!("{host} points to a private or reserved network address.")));
        }
    }
    Ok(Target { url, host, addr: first })
}

/// Convenience: parse + resolve.
pub async fn check(raw: &str, cfg: &Config) -> Result<Target, WebError> {
    resolve(parse(raw, cfg)?, cfg).await
}

pub fn host_allowed(host: &str, allow: &[String]) -> bool {
    allow.is_empty() || allow.iter().any(|d| host == d || host.ends_with(&format!(".{d}")))
}

/// True only for globally routable unicast addresses.
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public_v4(v4);
            }
            let s = v6.segments();
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00 // unique local fc00::/7
                || (s[0] & 0xffc0) == 0xfe80 // link local fe80::/10
                || (s[0] == 0x2001 && s[1] == 0x0db8) // documentation
                || (s[0] == 0x0064 && s[1] == 0xff9b) // NAT64 (could reach v4 internals)
                || s[0] == 0x2002) // 6to4 (embeds arbitrary v4)
        }
    }
}

fn is_public_v4(v4: Ipv4Addr) -> bool {
    let o = v4.octets();
    !(v4.is_private()
        || v4.is_loopback()
        || v4.is_link_local() // includes 169.254.169.254 cloud metadata
        || v4.is_broadcast()
        || v4.is_documentation()
        || v4.is_unspecified()
        || v4.is_multicast()
        || o[0] == 0
        || (o[0] == 100 && (o[1] & 0xc0) == 64) // CGNAT 100.64/10
        || (o[0] == 192 && o[1] == 0 && o[2] == 0) // IETF protocol assignments
        || (o[0] == 198 && (o[1] & 0xfe) == 18) // benchmarking 198.18/15
        || o[0] >= 240) // reserved + broadcast
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> Config {
        let mut c = Config::from_env();
        c.proxy_allow.clear();
        c.proxy_allow_private = false;
        c
    }

    #[test]
    fn blocks_internal_addresses() {
        for ip in ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "64:ff9b::a00:1", "2002:a00:1::1"] {
            assert!(!is_public(ip.parse().unwrap()), "{ip} should be blocked");
        }
        for ip in ["1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"] {
            assert!(is_public(ip.parse().unwrap()), "{ip} should be allowed");
        }
    }

    #[test]
    fn rejects_bad_urls() {
        let c = cfg();
        for bad in ["file:///etc/passwd", "http://user:pw@example.com", "javascript:alert(1)", "ftp://example.com", "http://example.com:22/", "http://metadata.google.internal/", "http://printer.local/", "not a url"] {
            assert!(parse(bad, &c).is_err(), "{bad} should be rejected");
        }
        let ok = parse("https://example.com:8443/a?b=c#frag", &c).unwrap();
        assert_eq!(ok.fragment(), None);
    }

    #[test]
    fn allowlist_suffix_match() {
        let allow = vec!["wikipedia.org".to_string()];
        assert!(host_allowed("en.wikipedia.org", &allow));
        assert!(host_allowed("wikipedia.org", &allow));
        assert!(!host_allowed("evilwikipedia.org", &allow));
        assert!(host_allowed("anything.com", &[]));
    }
}
