//! Shared server state: persisted preferences, installed-app registry,
//! simulated hardware metrics and the WebSocket broadcast bus.

use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use rand::Rng;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::{broadcast, Mutex, RwLock};

use crate::catalog;

pub struct AppState {
    pub data_dir: PathBuf,
    pub files_dir: PathBuf,
    pub prefs: RwLock<Value>,
    pub installed: RwLock<BTreeSet<String>>,
    pub metrics: Mutex<Metrics>,
    pub events: broadcast::Sender<String>,
    pub started: Instant,
    /// Serialises disk writes so concurrent saves never interleave.
    write_lock: Mutex<()>,
}

pub type SharedState = Arc<AppState>;

impl AppState {
    pub async fn load(data_dir: PathBuf) -> std::io::Result<Self> {
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

        // Seed a welcome document on first boot.
        let welcome = files_dir.join("welcome.md");
        if tokio::fs::metadata(&welcome).await.is_err() {
            tokio::fs::write(&welcome, WELCOME_DOC).await?;
        }

        let (events, _) = broadcast::channel(64);
        Ok(Self {
            data_dir,
            files_dir,
            prefs: RwLock::new(prefs),
            installed: RwLock::new(installed),
            metrics: Mutex::new(Metrics::default()),
            events,
            started: Instant::now(),
            write_lock: Mutex::new(()),
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

    async fn write_json(&self, name: &str, value: &Value) -> std::io::Result<()> {
        let _guard = self.write_lock.lock().await;
        let path = self.data_dir.join(name);
        let tmp = path.with_extension("json.tmp");
        tokio::fs::write(&tmp, serde_json::to_vec_pretty(value)?).await?;
        tokio::fs::rename(&tmp, &path).await
    }

    /// Push an event to every connected desktop session.
    pub fn emit(&self, kind: &str, payload: Value) {
        let _ = self.events.send(json!({ "type": kind, "data": payload }).to_string());
    }
}

async fn read_json(path: &Path) -> Option<Value> {
    let bytes = tokio::fs::read(path).await.ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn default_prefs() -> Value {
    json!({
        "theme": {
            "mode": "dark",
            "accent": "#7c5cff",
            "transparency": true,
            "wallpaper": "particles",
            "animateWallpaper": true
        },
        "taskbar": {
            "position": "bottom",
            "pinned": ["explorer", "appstore", "music", "movies", "notepad", "settings"],
            "autoHide": false,
            "centered": true
        },
        "desktop": {
            "shortcuts": [
                { "app": "appstore", "col": 0, "row": 0 },
                { "app": "notepad",  "col": 0, "row": 1 },
                { "app": "games",    "col": 0, "row": 2 },
                { "app": "cloud",    "col": 0, "row": 3 },
                { "app": "settings", "col": 0, "row": 4 }
            ]
        },
        "widgets": {
            "clock":   { "visible": true, "x": null, "y": null,  "style": "digital" },
            "perf":    { "visible": true, "x": null, "y": null },
            "weather": { "visible": true, "x": null, "y": null },
            "notes":   { "visible": false, "x": null, "y": null, "text": "" }
        },
        "boot": { "skipAnimation": false }
    })
}

// ---------------------------------------------------------------------------
// Simulated hardware metrics (random walk so graphs look organic)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct Metrics {
    pub cpu: f64,
    pub cores: Vec<f64>,
    pub ram_used_mb: f64,
    pub ram_total_mb: f64,
    pub gpu: f64,
    pub net_down_kbps: f64,
    pub net_up_kbps: f64,
    pub temp_c: f64,
    pub processes: u32,
}

impl Default for Metrics {
    fn default() -> Self {
        Self {
            cpu: 12.0,
            cores: vec![10.0; 8],
            ram_used_mb: 6144.0,
            ram_total_mb: 16384.0,
            gpu: 8.0,
            net_down_kbps: 420.0,
            net_up_kbps: 60.0,
            temp_c: 44.0,
            processes: 142,
        }
    }
}

impl Metrics {
    fn tick(&mut self) {
        let mut rng = rand::thread_rng();
        let walk = |v: f64, step: f64, lo: f64, hi: f64, rng: &mut rand::rngs::ThreadRng| {
            (v + rng.gen_range(-step..step)).clamp(lo, hi)
        };
        for c in self.cores.iter_mut() {
            *c = walk(*c, 9.0, 1.0, 100.0, &mut rng);
            // occasional burst
            if rng.gen_bool(0.03) {
                *c = rng.gen_range(55.0..98.0);
            }
        }
        self.cpu = self.cores.iter().sum::<f64>() / self.cores.len() as f64;
        self.ram_used_mb = walk(self.ram_used_mb, 180.0, 3500.0, 14500.0, &mut rng);
        self.gpu = walk(self.gpu, 6.0, 1.0, 100.0, &mut rng);
        self.net_down_kbps = walk(self.net_down_kbps, 350.0, 20.0, 9800.0, &mut rng);
        self.net_up_kbps = walk(self.net_up_kbps, 60.0, 5.0, 2400.0, &mut rng);
        self.temp_c = (38.0 + self.cpu * 0.42 + rng.gen_range(-1.0..1.0)).clamp(30.0, 95.0);
        self.processes = (self.processes as i32 + rng.gen_range(-3..=3)).clamp(110, 220) as u32;
    }
}

/// Advances the simulated metrics every second and broadcasts them.
pub fn spawn_metrics_task(state: SharedState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        loop {
            interval.tick().await;
            let snapshot = {
                let mut m = state.metrics.lock().await;
                m.tick();
                m.clone()
            };
            if state.events.receiver_count() > 0 {
                state.emit("metrics", serde_json::to_value(snapshot).unwrap_or_default());
            }
        }
    });
}

const WELCOME_DOC: &str = r#"# Welcome to LTF OS

You are running **LTF OS** — a web desktop powered by a Rust kernel (well, an Axum server).

## Tips
- Right-click the taskbar to dock it to any screen edge.
- Drag an app from the taskbar onto the desktop to create a shortcut.
- Drag a desktop shortcut onto the taskbar to pin it.
- Press `Ctrl + Space` or click the logo to open Start.
- Settings → Personalization lets you pause the live wallpaper.

Files you save in Notepad are stored on the server in `data/files/`.
"#;
