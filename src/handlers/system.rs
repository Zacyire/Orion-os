use axum::{extract::State, Json};
use rand::Rng;
use serde_json::{json, Value};

use crate::state::{Metrics, SharedState};

pub async fn info(State(state): State<SharedState>) -> Json<Value> {
    let uptime = state.started.elapsed().as_secs();
    Json(json!({
        "name": "LTF OS",
        "version": env!("CARGO_PKG_VERSION"),
        "codename": "Low Taper Fade",
        "kernel": format!("ltf-{}-axum", env!("CARGO_PKG_VERSION")),
        "host": std::env::var("HOSTNAME").unwrap_or_else(|_| "ninja".into()),
        "arch": std::env::consts::ARCH,
        "platform": std::env::consts::OS,
        "cpu": "Taper Ryzen 9 7950X3D (16) @ 5.7GHz",
        "gpu": "NVIDIA GeForce RTX 4090 (virtual)",
        "uptime_secs": uptime,
    }))
}

pub async fn stats(State(state): State<SharedState>) -> Json<Metrics> {
    Json(state.metrics.lock().await.clone())
}

/// Lines streamed by the Arch-style boot screen.
pub async fn boot_log() -> Json<Vec<Value>> {
    let units = [
        ("ok", "Reached target Local File Systems."),
        ("ok", "Started LTF OS Kernel (tokio runtime)."),
        ("ok", "Mounted /dev/ltf0 on /home."),
        ("ok", "Started Journal Service."),
        ("ok", "Reached target System Initialization."),
        ("ok", "Started D-Bus System Message Bus."),
        ("ok", "Listening on WebSocket Event Socket (/ws)."),
        ("ok", "Started Network Manager."),
        ("ok", "Reached target Network."),
        ("ok", "Started Compositor (Mica/Acrylic backend)."),
        ("ok", "Loaded App Registry."),
        ("ok", "Started Pipewire Audio Service."),
        ("ok", "Started Hardware Monitor Daemon."),
        ("warn", "Fade level below threshold, applying low taper."),
        ("ok", "Started Ninja Hairline Service."),
        ("ok", "Reached target Graphical Interface."),
        ("ok", "Started LTF Desktop Session."),
    ];
    Json(units.iter().map(|(s, m)| json!({ "status": s, "msg": m })).collect())
}

pub async fn weather() -> Json<Value> {
    let mut rng = rand::thread_rng();
    let conditions = [
        ("Sunny", "sun"),
        ("Partly cloudy", "cloud-sun"),
        ("Cloudy", "cloud"),
        ("Light rain", "rain"),
        ("Thunderstorms", "storm"),
    ];
    let (label, icon) = conditions[rng.gen_range(0..conditions.len())];
    let temp: i32 = rng.gen_range(14..31);
    let forecast: Vec<Value> = ["Mon", "Tue", "Wed", "Thu", "Fri"]
        .iter()
        .map(|d| {
            let (l, i) = conditions[rng.gen_range(0..conditions.len())];
            json!({ "day": d, "hi": temp + rng.gen_range(0..6), "lo": temp - rng.gen_range(4..10), "label": l, "icon": i })
        })
        .collect();
    Json(json!({
        "city": "Fade City",
        "temp": temp,
        "feels_like": temp + rng.gen_range(-2..3),
        "humidity": rng.gen_range(30..90),
        "wind_kph": rng.gen_range(2..30),
        "label": label,
        "icon": icon,
        "forecast": forecast,
    }))
}
