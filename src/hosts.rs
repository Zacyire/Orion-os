//! Trusted-host policy (DNS-rebinding defence) and same-origin checks.
//!
//! The server binds 0.0.0.0, so it is reachable by IP on the LAN as well as on
//! loopback. What must never be trusted is an arbitrary **hostname**: in a DNS
//! rebinding attack a hostile page at `http://evil.example:8080` re-resolves
//! its own name to this server, so the browser treats it as same-origin with
//! `/api` — but the request still carries `Host: evil.example:8080`.
//!
//! Accepted `Host` values (case-insensitive, any valid port or none):
//! * `localhost`
//! * IP literals — IPv4 (`127.0.0.1`, `192.168.1.20`) and bracketed IPv6
//!   (`[::1]`), except the unspecified addresses `0.0.0.0` / `[::]`. An IP
//!   literal can't be produced by DNS rebinding: the page's own URL would have
//!   to be that IP, i.e. the page is served by this server.
//! * exact hostnames listed by the operator in `LTF_ALLOWED_HOSTS`
//!   (comma-separated, e.g. `ltf.home.lan,mypc`) for LAN names or a reverse
//!   proxy. Exact match only — no wildcards, no suffix matching.
//!
//! Rejected: every other hostname (including `*.localhost` subdomains and
//! look-alikes such as `localhost.evil.example`), malformed values (userinfo,
//! paths, spaces, bad ports, IPv6 zone ids), and a missing Host.
//!
//! The port is deliberately not a trust signal (reverse proxies change it);
//! the hostname is.
//!
//! Future package origins (Vapor "Model B", `docs/vapor-architecture.md` §9)
//! must be added as a separate, structured host class that routes ONLY to that
//! package's files — never by widening this list or adding a wildcard.

/// A parsed `host[:port]` authority.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Authority {
    /// Lowercased host; IPv6 without brackets.
    pub host: String,
    pub port: Option<u16>,
    pub is_ipv6: bool,
}

/// Parse `host[:port]` as it appears in `Host` or in an origin. Returns `None`
/// for anything that isn't a plain authority (userinfo, path, query, spaces,
/// bad port, empty host, IPv6 zone ids, …).
pub fn parse_authority(value: &str) -> Option<Authority> {
    if value.is_empty() || value.len() > 255 {
        return None;
    }
    if value.bytes().any(|b| !(b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':' | b'[' | b']'))) {
        return None; // rejects '@', '/', '?', '#', '%', whitespace, '_' …
    }
    let (host, port, is_ipv6) = if let Some(rest) = value.strip_prefix('[') {
        let (inner, after) = rest.split_once(']')?;
        let port = match after {
            "" => None,
            p => Some(parse_port(p.strip_prefix(':')?)?),
        };
        inner.parse::<std::net::Ipv6Addr>().ok()?;
        (inner.to_ascii_lowercase(), port, true)
    } else {
        if value.contains('[') || value.contains(']') {
            return None;
        }
        let (h, p) = match value.split_once(':') {
            Some((h, p)) => (h, Some(parse_port(p)?)),
            None => (value, None),
        };
        (h.to_ascii_lowercase(), p, false)
    };
    if host.is_empty() {
        return None;
    }
    Some(Authority { host, port, is_ipv6 })
}

fn parse_port(p: &str) -> Option<u16> {
    if p.is_empty() || p.len() > 5 || !p.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    match p.parse::<u16>() {
        Ok(0) | Err(_) => None,
        Ok(n) => Some(n),
    }
}

/// Valid DNS hostname (labels of letters/digits/hyphens, no leading/trailing
/// hyphen, no empty labels, no trailing dot).
fn is_hostname(h: &str) -> bool {
    !h.is_empty()
        && h.len() <= 253
        && h.split('.').all(|l| {
            !l.is_empty() && l.len() <= 63 && !l.starts_with('-') && !l.ends_with('-') && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

#[derive(Debug, Clone, Default)]
pub struct HostPolicy {
    /// Operator-approved exact hostnames (lowercase).
    extra: Vec<String>,
}

impl HostPolicy {
    /// Build from `LTF_ALLOWED_HOSTS` entries. Invalid entries (wildcards,
    /// ports, IPs, junk) are dropped with a warning rather than widening trust.
    pub fn new(entries: &[String]) -> Self {
        let mut extra = Vec::new();
        for raw in entries {
            let e = raw.trim().to_ascii_lowercase();
            if e.is_empty() {
                continue;
            }
            if is_hostname(&e) && e.parse::<std::net::Ipv4Addr>().is_err() {
                extra.push(e);
            } else {
                tracing::warn!(entry = %raw, "ignoring invalid LTF_ALLOWED_HOSTS entry (exact hostnames only; no ports or wildcards)");
            }
        }
        HostPolicy { extra }
    }

    /// Is this parsed authority a trusted host for this server?
    pub fn allows(&self, a: &Authority) -> bool {
        if a.is_ipv6 {
            let ip: std::net::Ipv6Addr = match a.host.parse() {
                Ok(ip) => ip,
                Err(_) => return false,
            };
            return !ip.is_unspecified();
        }
        if let Ok(ip) = a.host.parse::<std::net::Ipv4Addr>() {
            return !ip.is_unspecified();
        }
        // Reject non-canonical numeric forms ("127.1", "0x7f.0.0.1", "2130706433"):
        // browsers normalise them, so they never arrive legitimately as hostnames.
        if a.host.bytes().all(|b| b.is_ascii_digit() || b == b'.') || a.host.starts_with("0x") {
            return false;
        }
        is_hostname(&a.host) && (a.host == "localhost" || self.extra.iter().any(|h| *h == a.host))
    }

    /// Check a raw `Host` header value.
    pub fn allows_host_header(&self, value: &str) -> bool {
        parse_authority(value).is_some_and(|a| self.allows(&a))
    }
}

/// Is `origin` (from an `Origin` header) exactly the origin of a request whose
/// `Host` is `host`? Requires `http`/`https`, no path/userinfo, `null` never
/// matches. A missing port on either side means the scheme's default.
pub fn origin_matches_host(origin: &str, host: &str) -> bool {
    let (scheme, rest) = match origin.split_once("://") {
        Some(p) => p,
        None => return false,
    };
    let default_port = match scheme {
        "http" => 80,
        "https" => 443,
        _ => return false,
    };
    let (Some(o), Some(h)) = (parse_authority(rest), parse_authority(host)) else {
        return false;
    };
    let effective = |a: &Authority| a.port.unwrap_or(default_port);
    o.host == h.host && o.is_ipv6 == h.is_ipv6 && effective(&o) == effective(&h)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> HostPolicy {
        HostPolicy::new(&["ltf.home.lan".into(), "*.bad".into(), "has:8080".into(), "10.0.0.1".into()])
    }

    #[test]
    fn accepts_legitimate_hosts() {
        let p = policy();
        for h in [
            "localhost", "LOCALHOST", "localhost:8080", "127.0.0.1", "127.0.0.1:8080", "192.168.1.20:8080",
            "[::1]", "[::1]:8080", "ltf.home.lan", "LTF.Home.Lan:443",
        ] {
            assert!(p.allows_host_header(h), "should accept {h}");
        }
    }

    #[test]
    fn rejects_arbitrary_and_misleading_hosts() {
        let p = policy();
        for h in [
            "evil.example", "evil.example:8080", "localhost.evil.example", "127.0.0.1.nip.io", "evil.localhost",
            "blocks.pkg.localhost:8080", "localhost.", "ltf.home.lan.evil.example", "home.lan", "x.ltf.home.lan",
            "anything.bad", "has",
        ] {
            assert!(!p.allows_host_header(h), "should reject {h}");
        }
    }

    #[test]
    fn rejects_malformed_hosts() {
        let p = policy();
        for h in [
            "", " ", "localhost:", "localhost:0", "localhost:65536", "localhost:80a", "localhost:8080:1", "user@localhost",
            "localhost/path", "localhost?x", "localhost#x", "local host", "localhost\t", "[::1", "::1", "[::1]x",
            "[fe80::1%25eth0]", "[localhost]", "0.0.0.0", "0.0.0.0:8080", "[::]", "127.1", "0x7f.0.0.1", "2130706433",
            "-bad.example", "a..b", "_x",
        ] {
            assert!(!p.allows_host_header(h), "should reject {h:?}");
        }
    }

    #[test]
    fn invalid_allowlist_entries_are_ignored_not_widened() {
        let p = policy();
        assert!(!p.allows_host_header("anything.bad"), "wildcard entries must not work");
        assert!(!p.allows_host_header("has:8080"), "entries with ports are dropped");
    }

    #[test]
    fn origin_must_match_host_exactly() {
        assert!(origin_matches_host("http://127.0.0.1:8080", "127.0.0.1:8080"));
        assert!(origin_matches_host("http://localhost:8080", "LOCALHOST:8080"));
        assert!(origin_matches_host("http://localhost", "localhost:80"));
        assert!(origin_matches_host("https://ltf.home.lan", "ltf.home.lan"));
        assert!(origin_matches_host("http://[::1]:8080", "[::1]:8080"));
        for (o, h) in [
            ("null", "localhost:8080"),
            ("https://evil.example", "localhost:8080"),
            ("http://localhost:8081", "localhost:8080"),
            ("http://localhost.evil.example:8080", "localhost:8080"),
            ("http://localhost:8080@evil.example", "localhost:8080"),
            ("http://localhost:8080/", "localhost:8080"),
            ("ws://localhost:8080", "localhost:8080"),
            ("file://", "localhost:8080"),
            ("http://127.0.0.1:8080", "localhost:8080"),
            ("http://localhost", "localhost:8080"),
            ("", "localhost:8080"),
        ] {
            assert!(!origin_matches_host(o, h), "{o} vs {h} must not match");
        }
    }
}
