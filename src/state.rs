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

use crate::{catalog, config::Config};

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
    /// Serialises disk writes so concurrent saves never interleave.
    write_lock: Mutex<()>,
}

pub type SharedState = Arc<AppState>;

impl AppState {
    pub async fn load(config: Config) -> std::io::Result<Self> {
        let data_dir = &config.data_dir;
        let files_dir = data_dir.join("files");
        tokio::fs::create_dir_all(&files_dir).await?;

        let prefs = match read_json(&data_dir.join("prefs.json")).await {
            Some(v) if v.is_object() => v,
            _ => default_prefs(),
        };
        let installed = match read_json(&data_dir.join("installed.json")).await {
            Some(Value::Array(a)) => a.into_iter().filter_map(|v| v.as_str().map(String::from)).collect(),
            _ => catalog::default_installed(),
        };
        let custom_apps = read_json(&data_dir.join("custom_apps.json"))
            .await
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();

        let welcome = files_dir.join("welcome.md");
        if tokio::fs::metadata(&welcome).await.is_err() {
            tokio::fs::write(&welcome, WELCOME_DOC).await?;
        }

        let http = reqwest::Client::builder()
            .user_agent(concat!("Mozilla/5.0 (compatible; LTF-OS/", env!("CARGO_PKG_VERSION"), ")"))
            .timeout(Duration::from_secs(20))
            .connect_timeout(Duration::from_secs(8))
            // Redirects are handled by the proxy itself so every hop is re-validated.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(std::io::Error::other)?;

        let (events, _) = broadcast::channel(64);
        Ok(Self {
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
            "pinned": ["orion", "notnetflix", "spiceify", "youtube", "vapor", "geforcenow", "appstore"],
            "autoHide": false,
            "centered": true
        },
        "desktop": {
            "shortcuts": [
                { "app": "orion",      "col": 0, "row": 0 },
                { "app": "notnetflix", "col": 0, "row": 1 },
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

const WELCOME_DOC: &str = r#"# Welcome to LTF OS

This document lives on the server in `data/files/` and is editable in Notepad.

## Getting started
- Right-click the taskbar (or open Settings → Taskbar) to dock it to any screen edge.
- Drag an app from the taskbar onto the desktop to create a shortcut; drag a shortcut onto the taskbar to pin it.
- Content for NotNetflix, Spiceify, Vapor, YouTube and wallpapers is defined in the `content/` directory.
- Add any website as an app from App Store → Add web app.
"#;
