//! Shared server state: persisted preferences, the installed-app registry,
//! creator-added web apps, the outbound HTTP client and the WebSocket bus.

use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{broadcast, Mutex, RwLock};

use crate::{
    catalog,
    config::Config,
    sysstats::Sampler,
    hosts::HostPolicy,
    netstats::NetSampler,
    web::{inspect::InspectCache, limit::RateLimiter},
};

/// A web app added from the App Store ("Add web app"). Rendered by the
/// generic `embed` module as an iframe.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomApp {
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub proxy: bool,
}

pub struct AppState {
    pub config: Config,
    pub files_dir: PathBuf,
    pub prefs: RwLock<Value>,
    pub installed: RwLock<BTreeSet<String>>,
    pub custom_apps: RwLock<Vec<CustomApp>>,
    pub events: broadcast::Sender<String>,
    pub started: Instant,
    pub http: reqwest::Client,
    pub limiter: RateLimiter,
    pub inspect_cache: InspectCache,
    /// Read-only host stats sampler behind GET /api/system/stats.
    pub sysstats: Sampler,
    /// Read-only connectivity/latency sampler behind GET /api/network/stats.
    pub netstats: NetSampler,
    /// Trusted `Host` values (DNS-rebinding defence), from config.
    pub hosts: HostPolicy,
    /// Private-beta access gate; `None` when no access key is configured.
    pub gate: Option<crate::auth::Gate>,
    /// Serialises disk writes so concurrent saves never interleave.
    write_lock: Mutex<()>,
}

pub type SharedState = Arc<AppState>;

impl AppState {
    pub async fn load(config: Config) -> std::io::Result<Self> {
        let data_dir = &config.data_dir;
        let files_dir = data_dir.join("files");
        tokio::fs::create_dir_all(&files_dir).await?;

        let mut prefs = match read_json(&data_dir.join("prefs.json")).await {
            Some(v) if v.is_object() => v,
            _ => default_prefs(),
        };
        let mut installed: BTreeSet<String> = match read_json(&data_dir.join("installed.json")).await {
            Some(Value::Array(a)) => a.into_iter().filter_map(|v| v.as_str().map(String::from)).collect(),
            _ => catalog::default_installed(),
        };
        migrate_ids(&mut prefs, &mut installed);
        let custom_apps = read_json(&data_dir.join("custom_apps.json"))
            .await
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();

        let welcome = files_dir.join("welcome.md");
        if tokio::fs::metadata(&welcome).await.is_err() {
            tokio::fs::write(&welcome, WELCOME_DOC).await?;
        }

        let http = reqwest::Client::builder()
            .user_agent(concat!("Mozilla/5.0 (compatible; Orion-OS/", env!("CARGO_PKG_VERSION"), ")"))
            .timeout(Duration::from_secs(20))
            .connect_timeout(Duration::from_secs(8))
            // Redirects are handled by the proxy itself so every hop is re-validated.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(std::io::Error::other)?;

        let netstats = NetSampler::new(config.netcheck_url.clone());
        let mut hosts = HostPolicy::new(&config.allowed_hosts);
        if config.mode == crate::config::Mode::Beta {
            hosts = hosts.https_origins_only();
        }
        let gate = crate::auth::Gate::from_config(&config);

        let (events, _) = broadcast::channel(64);
        let limiter = RateLimiter::new(config.rate_limit_per_min);
        Ok(Self {
            limiter,
            inspect_cache: InspectCache::default(),
            sysstats: Sampler::new(),
            netstats,
            hosts,
            gate,
            files_dir,
            prefs: RwLock::new(prefs),
            installed: RwLock::new(installed),
            custom_apps: RwLock::new(custom_apps),
            events,
            started: Instant::now(),
            http,
            write_lock: Mutex::new(()),
            config,
        })
    }

    pub async fn save_prefs(&self) -> std::io::Result<()> {
        let snapshot = self.prefs.read().await.clone();
        self.write_json("prefs.json", &snapshot).await
    }

    pub async fn save_installed(&self) -> std::io::Result<()> {
        let snapshot: Vec<String> = self.installed.read().await.iter().cloned().collect();
        self.write_json("installed.json", &json!(snapshot)).await
    }

    pub async fn save_custom_apps(&self) -> std::io::Result<()> {
        let snapshot = serde_json::to_value(&*self.custom_apps.read().await)?;
        self.write_json("custom_apps.json", &snapshot).await
    }

    async fn write_json(&self, name: &str, value: &Value) -> std::io::Result<()> {
        let _guard = self.write_lock.lock().await;
        let path = self.config.data_dir.join(name);
        let tmp = path.with_extension("json.tmp");
        tokio::fs::write(&tmp, serde_json::to_vec_pretty(value)?).await?;
        tokio::fs::rename(&tmp, &path).await
    }

    /// Push an event to every connected desktop session.
    pub fn emit(&self, kind: &str, payload: Value) {
        let _ = self.events.send(json!({ "type": kind, "data": payload }).to_string());
    }
}

pub async fn read_json(path: &Path) -> Option<Value> {
    let bytes = tokio::fs::read(path).await.ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// App ids that were renamed; old ids in saved prefs/installs are rewritten on load.
const RENAMED_APPS: &[(&str, &str)] = &[("notnetflix", "netflix")];

fn migrate_ids(prefs: &mut Value, installed: &mut BTreeSet<String>) {
    for (old, new) in RENAMED_APPS {
        if installed.remove(*old) {
            installed.insert((*new).to_string());
        }
        if let Some(pinned) = prefs.pointer_mut("/taskbar/pinned").and_then(Value::as_array_mut) {
            for id in pinned.iter_mut().filter(|v| v == old) {
                *id = json!(new);
            }
        }
        if let Some(shortcuts) = prefs.pointer_mut("/desktop/shortcuts").and_then(Value::as_array_mut) {
            for s in shortcuts.iter_mut().filter(|s| s["app"] == *old) {
                s["app"] = json!(new);
            }
        }
    }
}

pub fn default_prefs() -> Value {
    json!({
        "user": { "name": "User" },
        "theme": {
            "mode": "dark",
            "accent": "#4c8dff",
            "transparency": true,
            "glassOpacity": 0.62,
            "wallpaper": "default",
            "animateWallpaper": true
        },
        "taskbar": {
            "position": "bottom",
            "pinned": ["orion", "netflix", "spiceify", "youtube", "vapor", "geforcenow", "appstore"],
            "autoHide": false,
            "centered": true
        },
        "desktop": {
            "shortcuts": [
                { "app": "orion",      "col": 0, "row": 0 },
                { "app": "netflix", "col": 0, "row": 1 },
                { "app": "spiceify",   "col": 0, "row": 2 },
                { "app": "youtube",    "col": 0, "row": 3 },
                { "app": "vapor",      "col": 0, "row": 4 },
                { "app": "geforcenow", "col": 0, "row": 5 },
                { "app": "appstore",   "col": 1, "row": 0 },
                { "app": "notepad",    "col": 1, "row": 1 },
                { "app": "settings",   "col": 1, "row": 2 }
            ]
        },
        "boot": { "skipAnimation": false }
    })
}

const WELCOME_DOC: &str = r#"# Welcome to Orion OS

This document lives on the server in `data/files/` and is editable in Notepad.

## Getting started
- Right-click the taskbar (or open Settings → Taskbar) to dock it to any screen edge.
- Drag an app from the taskbar onto the desktop to create a shortcut; drag a shortcut onto the taskbar to pin it.
- Content for Spiceify, Vapor, YouTube and wallpapers is defined in the `content/` directory.
- Any website can become an app: App Store → Add web app, or one entry in `static/apps.json`.
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_renamed_app_ids() {
        let mut prefs = json!({ "taskbar": { "pinned": ["orion", "notnetflix"] }, "desktop": { "shortcuts": [{ "app": "notnetflix", "col": 0, "row": 1 }] } });
        let mut installed: BTreeSet<String> = ["notnetflix".to_string()].into();
        migrate_ids(&mut prefs, &mut installed);
        assert_eq!(prefs["taskbar"]["pinned"], json!(["orion", "netflix"]));
        assert_eq!(prefs["desktop"]["shortcuts"][0]["app"], "netflix");
        assert!(installed.contains("netflix") && !installed.contains("notnetflix"));
    }
}
