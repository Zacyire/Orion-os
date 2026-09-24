//! Runtime configuration, read once from environment variables.

use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Config {
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
}

impl Config {
    pub fn from_env() -> Self {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        Self {
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
        }
    }
}
