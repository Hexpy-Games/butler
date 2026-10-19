use super::record::severity;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Preset {
    Minimal,
    #[default]
    Standard,
    Detailed,
    Full,
}
impl Preset {
    pub fn threshold(&self) -> u8 {
        match self {
            Self::Minimal => 2,
            Self::Standard => 3,
            Self::Detailed => 4,
            Self::Full => 5,
        }
    }
}
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct Config {
    pub level: Preset,
    #[serde(default)]
    pub category_levels: BTreeMap<String, String>,
}
impl Config {
    pub fn detailed() -> Self {
        Self {
            level: Preset::Detailed,
            ..Self::default()
        }
    }
    pub fn full() -> Self {
        Self {
            level: Preset::Full,
            ..Self::default()
        }
    }
    pub fn enabled(&self, category: &str, level: &str) -> bool {
        let threshold = self
            .category_levels
            .iter()
            .filter(|(key, _)| {
                category == key.as_str()
                    || category
                        .strip_prefix(key.as_str())
                        .is_some_and(|s| s.starts_with('.'))
            })
            .max_by_key(|(key, _)| key.len())
            .map(|(_, level)| severity(level))
            .unwrap_or(self.level.threshold());
        let value = severity(level);
        value > 0 && value <= threshold
    }
    pub(crate) fn verbose(&self) -> bool {
        self.level.threshold() >= 4 || self.category_levels.values().any(|v| severity(v) >= 4)
    }
    pub fn from_settings(value: &Value) -> Self {
        if value["diagnostics_enabled"] != true {
            return Self::default();
        }
        serde_json::from_value(json!({"level":value.get("log_level").cloned().unwrap_or(json!("standard")), "category_levels":value.get("log_category_levels").cloned().unwrap_or(json!({}))})).unwrap_or_default()
    }
    pub fn valid(&self) -> bool {
        self.category_levels
            .iter()
            .all(|(k, v)| !k.is_empty() && k.len() <= 128 && severity(v) > 0)
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct ConfigView {
    pub effective: Config,
    pub full_expires_at: Option<String>,
    pub freed_bytes: u64,
}
