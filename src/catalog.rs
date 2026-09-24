//! The App Registry catalogue.
//!
//! Single source of truth: `static/apps.json`, embedded at compile time and
//! also served statically so the frontend can boot without the backend.
//!
//! Three kinds of app (`"type"`):
//! * `"native"`  (default) — an ES module in `static/js/apps/<module>.js`.
//! * `"web-app"` — a website presented as a dedicated application: no
//!   address bar, tabs or history UI. Needs only `target`. Rendered by the
//!   shared web container (`static/js/apps/webapp.js`).
//! * `"browser"` — general-purpose navigation (Orion).
//!
//! Only `id` and `name` are required; everything else has a default, and any
//! extra fields (`target`, `navigation`, `addressBar`, `controls`, `proxy`,
//! `allow`, `sandbox`, `onBlocked`, `panel`, …) pass through to the frontend.

use std::{collections::BTreeSet, sync::OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogApp {
    pub id: String,
    pub name: String,
    #[serde(rename = "type", default = "default_type")]
    pub kind: String,
    /// JS module; defaults to `webapp` for web-apps and `orion` for browsers.
    #[serde(default)]
    pub module: Option<String>,
    #[serde(default = "default_icon")]
    pub icon: String,
    #[serde(default = "default_category")]
    pub category: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub developer: String,
    #[serde(default = "default_version")]
    pub version: String,
    /// System apps cannot be uninstalled.
    #[serde(default)]
    pub system: bool,
    /// Internal hosts (e.g. the game player window) — not listed in Start or the store.
    #[serde(default)]
    pub hidden: bool,
    #[serde(default = "default_size")]
    pub default_size: (u32, u32),
    /// Web-app / browser settings and any future fields, passed through as-is.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn default_type() -> String { "native".into() }
fn default_icon() -> String { "web".into() }
fn default_category() -> String { "Web".into() }
fn default_version() -> String { "1.0.0".into() }
fn default_size() -> (u32, u32) { (1180, 740) }

impl CatalogApp {
    /// Module that renders this app.
    pub fn resolved_module(&self) -> String {
        self.module.clone().unwrap_or_else(|| match self.kind.as_str() {
            "web-app" => "webapp".into(),
            "browser" => "orion".into(),
            _ => self.id.clone(),
        })
    }
}

const CATALOG_JSON: &str = include_str!("../static/apps.json");

pub fn all() -> &'static [CatalogApp] {
    static CATALOG: OnceLock<Vec<CatalogApp>> = OnceLock::new();
    CATALOG.get_or_init(|| serde_json::from_str(CATALOG_JSON).expect("static/apps.json is invalid"))
}

pub fn find(id: &str) -> Option<&'static CatalogApp> {
    all().iter().find(|a| a.id == id)
}

pub fn default_installed() -> BTreeSet<String> {
    all().iter().map(|a| a.id.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_valid() {
        let apps = all();
        let ids: std::collections::HashSet<_> = apps.iter().map(|a| &a.id).collect();
        assert_eq!(ids.len(), apps.len(), "ids must be unique");
        for a in apps {
            assert!(["native", "web-app", "browser"].contains(&a.kind.as_str()), "{}: unknown type {}", a.id, a.kind);
            if a.kind == "web-app" && !a.hidden {
                let target = a.extra.get("target").and_then(Value::as_str).unwrap_or_default();
                assert!(target.starts_with("https://") || target.starts_with("http://"), "{}: web-app needs an http(s) target", a.id);
            }
        }
        assert!(find("netflix").is_some() && find("notnetflix").is_none());
    }

    /// Built-in apps skip the frontend's local-app validation, so an unknown
    /// `runtime` would silently fall back to "direct". Check every built-in
    /// against the authoritative list in static/js/core/runtimes.js (parsed
    /// here, so the ids are still defined in exactly one place).
    #[test]
    fn builtin_runtimes_are_defined() {
        const RUNTIMES_JS: &str = include_str!("../static/js/core/runtimes.js");
        let known: Vec<&str> = RUNTIMES_JS
            .split("{ id: '")
            .skip(1)
            .filter_map(|s| s.split('\'').next())
            .collect();
        assert!(known.contains(&"direct") && known.contains(&"external"), "could not parse runtimes.js: {known:?}");
        for a in all() {
            if let Some(rt) = a.extra.get("runtime") {
                let rt = rt.as_str().unwrap_or_default();
                assert!(known.contains(&rt), "{}: runtime {rt:?} is not defined in runtimes.js {known:?}", a.id);
            }
        }
    }

    #[test]
    fn minimal_entry_gets_defaults() {
        let a: CatalogApp = serde_json::from_str(r#"{ "id": "example", "name": "Example", "type": "web-app", "target": "https://example.com" }"#).unwrap();
        assert_eq!(a.resolved_module(), "webapp");
        assert_eq!(a.extra["target"], "https://example.com");
        assert_eq!(a.default_size, (1180, 740));
    }
}
