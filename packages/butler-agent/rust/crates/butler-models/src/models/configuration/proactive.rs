//! Stored proactive preferences and the pure local-time quiet-hours predicate.
use super::{ModelConfiguration, SettingsError};
use butler_core::configuration;
use serde_json::Value;
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct QuietHours {
    start: u16,
    end: u16,
}
impl QuietHours {
    pub fn new(start: &str, end: &str) -> Option<Self> {
        let start = minute(start)?;
        let end = minute(end)?;
        (start != end).then_some(Self { start, end })
    }
    /// Start inclusive, end exclusive, including windows that cross midnight.
    pub fn contains(&self, local_minute: u16) -> bool {
        local_minute < 1440
            && if self.start < self.end {
                (self.start..self.end).contains(&local_minute)
            } else {
                local_minute >= self.start || local_minute < self.end
            }
    }
}
fn minute(value: &str) -> Option<u16> {
    let b = value.as_bytes();
    if b.len() != 5
        || b[2] != b':'
        || !b[..2].iter().all(u8::is_ascii_digit)
        || !b[3..].iter().all(u8::is_ascii_digit)
    {
        return None;
    }
    let hour: u16 = value[..2].parse().ok()?;
    let minute: u16 = value[3..].parse().ok()?;
    (hour < 24 && minute < 60).then_some(hour * 60 + minute)
}
impl ModelConfiguration {
    /// Merge only the source-owned fields under the shared configuration write lock.
    pub async fn set_proactive_settings(
        &self,
        patch: &Value,
        root: &Path,
    ) -> Result<(), SettingsError> {
        let patch = patch.clone();
        let guard = self.configuration_writes.acquire_owned().await;
        let path = root.join("butler.config.json");
        tokio::task::spawn_blocking(move || {
            let _guard = guard;
            let _change = configuration::lock_file(&path)?;
            let mut config = configuration::read_json_object(&path)?;
            validate(&patch, &config)?;
            let object = butler_core::json::object_mut(&mut config);
            let proactive = butler_core::json::object_field_mut(object, "proactive");
            if let Some(level) = patch.get("proactive_level") {
                proactive.insert("level".into(), level.clone());
            }
            let quiet = butler_core::json::object_field_mut(proactive, "quietHours");
            for (key, field) in [("quiet_hours_start", "start"), ("quiet_hours_end", "end")] {
                if let Some(value) = patch.get(key) {
                    quiet.insert(field.into(), value.clone());
                }
            }
            if patch.get("chats_intro_seen") == Some(&Value::Bool(true)) {
                butler_core::json::object_field_mut(object, "chats")
                    .insert("introSeen".into(), Value::Bool(true));
            }
            configuration::write_json_atomic(&path, &config)?;
            Ok(())
        })
        .await
        .map_err(SettingsError::WriteTask)?
    }
}
fn validate(patch: &Value, config: &Value) -> Result<(), SettingsError> {
    let start = patch
        .get("quiet_hours_start")
        .or_else(|| config.pointer("/proactive/quietHours/start"))
        .and_then(Value::as_str)
        .unwrap_or("22:00");
    let end = patch
        .get("quiet_hours_end")
        .or_else(|| config.pointer("/proactive/quietHours/end"))
        .and_then(Value::as_str)
        .unwrap_or("07:00");
    if QuietHours::new(start, end).is_none()
        || patch
            .get("proactive_level")
            .is_some_and(|v| !matches!(v.as_str(), Some("off" | "sometimes" | "often")))
        || patch
            .get("chats_intro_seen")
            .is_some_and(|v| v != &Value::Bool(true))
    {
        return Err(SettingsError::Rejected("Invalid proactive settings."));
    }
    Ok(())
}
