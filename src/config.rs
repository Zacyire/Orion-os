//! Runtime configuration, read once from environment variables.
//!
//! Two deployment modes (`LTF_MODE`):
//! * `development` (default) — unchanged local behaviour: binds `0.0.0.0`,
//!   no access gate unless `LTF_ACCESS_KEY` is set, cookies without `Secure`.
//! * `beta` — a private deployment behind an HTTPS reverse proxy. Binds
//!   `127.0.0.1` by default and refuses to start unless an access key and at
//!   least one trusted hostname are configured (see `Config::validate`).
//!   See docs/private-beta-deployment.md.

use std::{
    fmt,
    net::{IpAddr, Ipv4Addr},
    path::PathBuf,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Development,
    Beta,
}

/// A secret that never prints: `Debug` is redacted so a logged or
/// debug-formatted `Config` can't leak it.
#[derive(Clone)]
pub struct Secret(String);

impl Secret {
    pub fn new(s: String) -> Self {
        Secret(s)
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

/// Minimum access-key length. The key is the only credential, so it must be
/// long enough that online guessing (already rate limited) is hopeless.
pub const MIN_ACCESS_KEY_LEN: usize = 16;

#[derive(Debug, Clone)]
pub struct Config {
    pub mode: Mode,
    /// Listen address (`LTF_BIND`). Default `0.0.0.0` in development,
    /// `127.0.0.1` in beta (only the local reverse proxy should connect).
    pub bind: IpAddr,
    pub port: u16,
    /// Mutable runtime state: preferences, installs, user documents.
    pub data_dir: PathBuf,
    /// Frontend files served at `/`.
    pub static_dir: PathBuf,
    /// Creator-managed catalogues (music, games, videos, wallpapers).
    pub content_dir: PathBuf,
    /// Whether `/proxy` is enabled at all.
    pub proxy_enabled: bool,
    /// Optional host allowlist for `/proxy` (suffix match). Empty = any public host.
    pub proxy_allow: Vec<String>,
    /// Allow `/proxy` to reach private/loopback addresses. Off by default;
    /// only for development or trusted intranet deployments (SSRF risk).
    pub proxy_allow_private: bool,
    /// Route outbound requests through HTTP(S)_PROXY from the environment.
    /// Off by default: an intermediate proxy re-resolves DNS, which would
    /// bypass the address pinning that protects against DNS rebinding.
    pub use_env_proxy: bool,
    /// Trust `X-Forwarded-For` for rate limiting (only behind your own reverse proxy).
    pub trust_proxy_headers: bool,
    /// Web-layer requests allowed per client per minute (`LTF_RATE_LIMIT`).
    pub rate_limit_per_min: u32,
    /// YouTube Data API v3 key for `/api/youtube/search`.
    pub youtube_api_key: Option<String>,
    /// Fixed destination for the server-side connectivity/latency check
    /// (`/api/network/stats`). `LTF_NETCHECK_URL`; default
    /// `crate::netstats::DEFAULT_NETCHECK_URL`; set empty to disable.
    pub netcheck_url: Option<String>,
    /// Extra exact hostnames trusted in `Host` (`LTF_ALLOWED_HOSTS`, comma-
    /// separated) on top of `localhost` and IP literals. See src/hosts.rs.
    pub allowed_hosts: Vec<String>,
    /// Private-beta access key (`LTF_ACCESS_KEY`, or the first line of the
    /// file named by `LTF_ACCESS_KEY_FILE`). `Some` enables the access gate
    /// (src/auth.rs) in any mode; required in beta.
    pub access_key: Option<Secret>,
    /// Signed-in session lifetime in hours (`LTF_SESSION_HOURS`, 1–720, default 168).
    pub session_hours: u64,
    /// Problems found while reading the environment; reported by `validate`.
    errors: Vec<String>,
}

impl Config {
    pub fn from_env() -> Self {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        let mut errors = Vec::new();
        let mode = match var("LTF_MODE").as_deref().map(str::trim) {
            None | Some("development") | Some("dev") => Mode::Development,
            Some("beta") => Mode::Beta,
            Some(other) => {
                errors.push(format!("LTF_MODE must be `development` or `beta`, got {other:?}"));
                Mode::Beta // fail closed: validate() refuses to start anyway
            }
        };
        let bind = match var("LTF_BIND") {
            Some(v) => v.trim().parse().unwrap_or_else(|_| {
                errors.push(format!("LTF_BIND must be an IP address, got {v:?}"));
                IpAddr::V4(Ipv4Addr::LOCALHOST)
            }),
            None if mode == Mode::Beta => IpAddr::V4(Ipv4Addr::LOCALHOST),
            None => IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        };
        let access_key = match (var("LTF_ACCESS_KEY"), var("LTF_ACCESS_KEY_FILE")) {
            (Some(_), Some(_)) => {
                errors.push("set only one of LTF_ACCESS_KEY and LTF_ACCESS_KEY_FILE".into());
                None
            }
            (Some(k), None) => Some(k.trim().to_string()),
            (None, Some(path)) => match std::fs::read_to_string(path.trim()) {
                Ok(text) => Some(text.lines().next().unwrap_or("").trim().to_string()),
                // The path is operator-supplied config, not a secret; the file's contents never appear.
                Err(e) => {
                    errors.push(format!("cannot read LTF_ACCESS_KEY_FILE {path:?}: {e}"));
                    None
                }
            },
            (None, None) => None,
        };
        let session_hours = match var("LTF_SESSION_HOURS") {
            None => 168,
            Some(v) => match v.trim().parse::<u64>() {
                Ok(h) if (1..=720).contains(&h) => h,
                _ => {
                    errors.push(format!("LTF_SESSION_HOURS must be 1–720, got {v:?}"));
                    168
                }
            },
        };
        Self {
            mode,
            bind,
            access_key: access_key.map(Secret::new),
            session_hours,
            errors,
            port: var("PORT").and_then(|p| p.parse().ok()).unwrap_or(8080),
            data_dir: var("LTF_DATA_DIR").unwrap_or_else(|| "data".into()).into(),
            static_dir: var("LTF_STATIC_DIR").unwrap_or_else(|| "static".into()).into(),
            content_dir: var("LTF_CONTENT_DIR").unwrap_or_else(|| "content".into()).into(),
            proxy_enabled: var("LTF_PROXY").map(|v| v != "0" && v != "false" && v != "off").unwrap_or(true),
            proxy_allow: var("LTF_PROXY_ALLOW")
                .map(|v| v.split(',').map(|s| s.trim().trim_start_matches('.').to_lowercase()).filter(|s| !s.is_empty()).collect())
                .unwrap_or_default(),
            proxy_allow_private: var("LTF_PROXY_ALLOW_PRIVATE").is_some_and(|v| v == "1" || v == "true"),
            use_env_proxy: var("LTF_USE_ENV_PROXY").is_some_and(|v| v == "1" || v == "true"),
            trust_proxy_headers: var("LTF_TRUST_PROXY_HEADERS").is_some_and(|v| v == "1" || v == "true"),
            rate_limit_per_min: var("LTF_RATE_LIMIT").and_then(|v| v.parse().ok()).unwrap_or(240),
            youtube_api_key: var("YOUTUBE_API_KEY"),
            netcheck_url: match std::env::var("LTF_NETCHECK_URL") {
                Ok(v) if v.trim().is_empty() => None,                 // explicitly disabled
                Ok(v) => Some(v),                                     // operator override
                Err(_) => Some(crate::netstats::DEFAULT_NETCHECK_URL.to_string()),
            },
            allowed_hosts: var("LTF_ALLOWED_HOSTS").map(|v| v.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()).unwrap_or_default(),
        }
    }

    /// Refuse to start on unsafe or broken configuration. Beta mode fails
    /// closed: no access key, no trusted hostname, or private-network proxying
    /// is an error, never a silent fallback.
    pub fn validate(&self) -> Result<(), String> {
        let mut errors = self.errors.clone();
        if self.access_key.as_ref().is_some_and(|k| k.expose().chars().count() < MIN_ACCESS_KEY_LEN) {
            errors.push(format!("the access key must be at least {MIN_ACCESS_KEY_LEN} characters"));
        }
        if self.mode == Mode::Beta {
            if self.access_key.is_none() && !errors.iter().any(|e| e.contains("LTF_ACCESS_KEY")) {
                errors.push("LTF_MODE=beta requires LTF_ACCESS_KEY or LTF_ACCESS_KEY_FILE".into());
            }
            if crate::hosts::HostPolicy::new(&self.allowed_hosts).is_empty() {
                errors.push("LTF_MODE=beta requires LTF_ALLOWED_HOSTS to name the beta hostname (e.g. beta.example.com)".into());
            }
            if self.proxy_allow_private {
                errors.push("LTF_PROXY_ALLOW_PRIVATE is not allowed in beta mode".into());
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    /// Session cookies carry `Secure` (and the `__Host-` prefix) in beta,
    /// where the browser always reaches Orion OS over HTTPS.
    pub fn secure_cookies(&self) -> bool {
        self.mode == Mode::Beta
    }
}
