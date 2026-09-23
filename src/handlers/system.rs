use std::time::{SystemTime, UNIX_EPOCH};

use axum::{extract::State, Json};
use serde_json::{json, Value};

use crate::state::SharedState;

pub async fn info(State(state): State<SharedState>) -> Json<Value> {
    let c = &state.config;
    Json(json!({
        "name": "LTF OS",
        "version": env!("CARGO_PKG_VERSION"),
        "server": format!("ltf-os/{} (axum)", env!("CARGO_PKG_VERSION")),
        "arch": std::env::consts::ARCH,
        "platform": std::env::consts::OS,
        "uptime_secs": state.started.elapsed().as_secs(),
        "features": {
            "proxy": c.proxy_enabled,
            "proxy_allowlist": c.proxy_allow,
            "youtube_search": c.youtube_api_key.is_some(),
        },
    }))
}

/// Cheap endpoint for client-side round-trip latency measurement.
pub async fn ping() -> Json<Value> {
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    Json(json!({ "pong": true, "server_time": ms }))
}

/// systemd-style unit lines for the boot screen. `ok` lines are rendered
/// with a green `[  OK  ]` tag; the frontend interleaves "Starting …" lines.
pub async fn boot_log(State(state): State<SharedState>) -> Json<Vec<Value>> {
    let c = &state.config;
    let mut units: Vec<(&str, String)> = vec![
        ("ok", "Created slice Slice /system/getty.".into()),
        ("ok", "Started Dispatch Password Requests to Console Directory Watch.".into()),
        ("ok", "Reached target Local Encrypted Volumes.".into()),
        ("ok", "Reached target Path Units.".into()),
        ("ok", "Reached target Slice Units.".into()),
        ("ok", "Listening on Journal Socket.".into()),
        ("ok", "Mounted Kernel Configuration File System.".into()),
        ("ok", "Finished Load Kernel Modules.".into()),
        ("ok", "Started Journal Service.".into()),
        ("ok", "Finished Coldplug All udev Devices.".into()),
        ("ok", "Mounted LTF Data Volume.".into()),
        ("ok", "Reached target Local File Systems.".into()),
        ("ok", "Finished Create Volatile Files and Directories.".into()),
        ("ok", "Reached target System Initialization.".into()),
        ("ok", "Listening on D-Bus System Message Bus Socket.".into()),
        ("ok", "Reached target Sockets.".into()),
        ("ok", "Reached target Basic System.".into()),
        ("ok", "Started D-Bus System Message Bus.".into()),
        ("ok", "Started Network Configuration.".into()),
        ("ok", "Reached target Network.".into()),
        ("ok", format!("Started LTF API Server {} on port {}.", env!("CARGO_PKG_VERSION"), c.port)),
        ("ok", "Listening on LTF Event Socket (/ws).".into()),
        ("ok", "Loaded Application Registry.".into()),
    ];
    units.push(if c.proxy_enabled {
        ("ok", "Started Content Proxy Service.".into())
    } else {
        ("warn", "Content Proxy Service disabled by configuration (LTF_PROXY=0).".into())
    });
    if c.youtube_api_key.is_none() {
        units.push(("warn", "YouTube Data API key not configured; search disabled.".into()));
    }
    units.extend([
        ("ok", "Started User Login Management.".into()),
        ("ok", "Reached target Multi-User System.".into()),
        ("ok", "Started Display Compositor.".into()),
        ("ok", "Reached target Graphical Interface.".into()),
    ]);
    Json(units.into_iter().map(|(s, m)| json!({ "status": s, "msg": m })).collect())
}
