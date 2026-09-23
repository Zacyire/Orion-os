//! Mock media library + cloud gaming data.

use axum::{extract::State, Json};
use rand::Rng;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::state::SharedState;

/// Tracks are synthesised client-side with WebAudio; the server only
/// supplies the "sheet music" (tempo, key, scale, palette).
pub async fn tracks() -> Json<Value> {
    Json(json!([
        { "id": "t1", "title": "Low Taper Fade",   "artist": "Ninja & The Barbers", "album": "Imagine If",  "bpm": 112, "root": 45, "scale": "minor",      "wave": "sawtooth", "colors": ["#ff3cac", "#784ba0", "#2b86c5"] },
        { "id": "t2", "title": "Massive",          "artist": "Ninja & The Barbers", "album": "Imagine If",  "bpm": 128, "root": 48, "scale": "dorian",     "wave": "square",   "colors": ["#f9d423", "#ff4e50", "#8e2de2"] },
        { "id": "t3", "title": "Arch Btw",         "artist": "Pacman Syndicate",    "album": "Rolling Release", "bpm": 96, "root": 50, "scale": "pentatonic", "wave": "triangle", "colors": ["#1793d1", "#0f2027", "#2c5364"] },
        { "id": "t4", "title": "Mica Dreams",      "artist": "Acrylic",             "album": "Glass",       "bpm": 84,  "root": 43, "scale": "major",      "wave": "sine",     "colors": ["#a1c4fd", "#c2e9fb", "#7c5cff"] },
        { "id": "t5", "title": "Kernel Panic",     "artist": "Segfault",            "album": "Core Dumped", "bpm": 140, "root": 40, "scale": "phrygian",   "wave": "sawtooth", "colors": ["#ff0844", "#ffb199", "#1a1a2e"] },
        { "id": "t6", "title": "Fade Into You",    "artist": "The Tapers",          "album": "Clippers",    "bpm": 100, "root": 52, "scale": "minor",      "wave": "triangle", "colors": ["#43e97b", "#38f9d7", "#0b3d2e"] }
    ]))
}

pub async fn videos() -> Json<Value> {
    // Public-domain / CC-licensed sample films served from Google's sample bucket.
    const BASE: &str = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample";
    Json(json!([
        { "id": "v1", "title": "Big Buck Bunny",     "year": 2008, "duration": "9:56",  "genre": "Animation", "src": format!("{BASE}/BigBuckBunny.mp4"),     "poster": format!("{BASE}/images/BigBuckBunny.jpg") },
        { "id": "v2", "title": "Elephants Dream",    "year": 2006, "duration": "10:53", "genre": "Sci-Fi",    "src": format!("{BASE}/ElephantsDream.mp4"),   "poster": format!("{BASE}/images/ElephantsDream.jpg") },
        { "id": "v3", "title": "Sintel",             "year": 2010, "duration": "14:48", "genre": "Fantasy",   "src": format!("{BASE}/Sintel.mp4"),           "poster": format!("{BASE}/images/Sintel.jpg") },
        { "id": "v4", "title": "Tears of Steel",     "year": 2012, "duration": "12:14", "genre": "Sci-Fi",    "src": format!("{BASE}/TearsOfSteel.mp4"),     "poster": format!("{BASE}/images/TearsOfSteel.jpg") },
        { "id": "v5", "title": "For Bigger Blazes",  "year": 2013, "duration": "0:15",  "genre": "Short",     "src": format!("{BASE}/ForBiggerBlazes.mp4"),  "poster": format!("{BASE}/images/ForBiggerBlazes.jpg") },
        { "id": "v6", "title": "Subaru Outback",     "year": 2014, "duration": "0:59",  "genre": "Short",     "src": format!("{BASE}/SubaruOutbackOnStreetAndDirt.mp4"), "poster": format!("{BASE}/images/SubaruOutbackOnStreetAndDirt.jpg") }
    ]))
}

pub async fn cloud_games() -> Json<Value> {
    Json(json!([
        { "id": "g1", "title": "Cyber Taper 2077",     "genre": "RPG",       "rating": 4.6, "players": "1",   "tier": "Ultimate", "colors": ["#fcee0a", "#00f0ff"], "embed": "snake" },
        { "id": "g2", "title": "Fadenite",             "genre": "Battle Royale", "rating": 4.4, "players": "1-100", "tier": "Free", "colors": ["#7b2ff7", "#f107a3"], "embed": "pong" },
        { "id": "g3", "title": "Arch of Empires",      "genre": "Strategy",  "rating": 4.7, "players": "1-8", "tier": "Priority", "colors": ["#1793d1", "#0a2540"], "embed": "blocks" },
        { "id": "g4", "title": "Red Dead Clippers",    "genre": "Adventure", "rating": 4.9, "players": "1",   "tier": "Ultimate", "colors": ["#b31217", "#e52d27"], "embed": "snake" },
        { "id": "g5", "title": "Hairline Horizon",     "genre": "Racing",    "rating": 4.5, "players": "1-12", "tier": "Priority", "colors": ["#f7971e", "#ffd200"], "embed": "pong" },
        { "id": "g6", "title": "Minetaper",            "genre": "Sandbox",   "rating": 4.8, "players": "1-30", "tier": "Free", "colors": ["#56ab2f", "#a8e063"], "embed": "blocks" },
        { "id": "g7", "title": "Ninja Gaiden: Fade",   "genre": "Action",    "rating": 4.3, "players": "1",   "tier": "Ultimate", "colors": ["#232526", "#ff416c"], "embed": "snake" },
        { "id": "g8", "title": "Massive Effect",       "genre": "Sci-Fi RPG","rating": 4.7, "players": "1",   "tier": "Priority", "colors": ["#4776e6", "#8e54e9"], "embed": "blocks" }
    ]))
}

pub async fn cloud_servers() -> Json<Value> {
    let mut rng = rand::thread_rng();
    let regions = [("US East", 18), ("US West", 42), ("EU Central", 88), ("EU West", 76), ("Asia Pacific", 154)];
    Json(Value::Array(
        regions
            .iter()
            .map(|(name, base)| {
                let ping = base + rng.gen_range(0..12);
                json!({ "region": name, "ping": ping, "load": rng.gen_range(18..96), "gpu": "RTX 4080 SuperPOD" })
            })
            .collect(),
    ))
}

#[derive(Deserialize)]
pub struct SessionReq {
    pub game: String,
    pub region: Option<String>,
}

pub async fn cloud_session(State(state): State<SharedState>, Json(req): Json<SessionReq>) -> Json<Value> {
    let mut rng = rand::thread_rng();
    let session = json!({
        "session_id": format!("fn-{:08x}", rng.gen::<u32>()),
        "game": req.game,
        "region": req.region.unwrap_or_else(|| "US East".into()),
        "resolution": "3840x2160",
        "fps": 120,
        "codec": "AV1",
        "bitrate_mbps": rng.gen_range(45..75),
        "queue_position": 0,
    });
    state.emit("cloud-session", session.clone());
    Json(session)
}
