//! The App Registry catalogue served to the AppStore.
//!
//! Single source of truth: `static/apps.json`, embedded at compile time and
//! also served statically so the frontend can boot without the backend.
//! Each `module` must match a frontend file in `static/js/apps/<module>.js`.

use std::{collections::BTreeSet, sync::OnceLock};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogApp {
    pub id: String,
    pub name: String,
    pub module: String,
    pub icon: String,
    pub category: String,
    pub description: String,
    pub developer: String,
    pub version: String,
    pub size_mb: f64,
    pub rating: f64,
    /// System apps cannot be uninstalled.
    #[serde(default)]
    pub system: bool,
    pub default_size: (u32, u32),
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
    ["explorer", "appstore", "settings", "notepad", "music", "movies", "games", "cloud", "terminal", "taskmgr"]
        .into_iter()
        .map(String::from)
        .collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn catalog_parses_and_ids_are_unique() {
        let apps = super::all();
        assert!(apps.len() >= 6);
        let ids: std::collections::HashSet<_> = apps.iter().map(|a| &a.id).collect();
        assert_eq!(ids.len(), apps.len());
    }
}
