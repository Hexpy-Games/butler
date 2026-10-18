//! Log preferences share the existing durable settings transaction.
use serde_json::{Map, Value, json};

pub(super) fn valid(input: &Value) -> bool {
    input.get("log_level").is_none_or(|v| {
        matches!(
            v.as_str(),
            Some("minimal" | "standard" | "detailed" | "full")
        )
    }) && input.get("log_category_levels").is_none_or(|v| {
        v.as_object().is_some_and(|m| {
            m.iter().all(|(k, v)| {
                !k.is_empty()
                    && k.len() <= 128
                    && matches!(
                        v.as_str(),
                        Some("error" | "warn" | "info" | "debug" | "trace")
                    )
            })
        })
    })
}
pub(super) fn project(current: &Value, patch: &Value, output: &mut Value) {
    for key in ["log_level", "log_category_levels"] {
        if let Some(v) = patch.get(key) {
            output[key] = v.clone();
        }
    }
    let level = output["log_level"].as_str().unwrap_or("standard");
    if level == "full" && current["log_level"] != "full" {
        output["log_full"] = json!({"expires_at":(chrono::Utc::now()+chrono::Duration::minutes(60)).to_rfc3339_opts(chrono::SecondsFormat::Micros,true),"previous":current.get("log_level").cloned().unwrap_or(json!("standard"))});
    } else if level != "full" {
        output["log_full"] = Value::Null;
    }
}
pub(super) fn view(stored: &Map<String, Value>, output: &mut Map<String, Value>) {
    output.insert(
        "diagnostics_enabled".into(),
        json!(
            stored
                .get("diagnostics_enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        ),
    );

    output.insert(
        "log_level".into(),
        stored
            .get("log_level")
            .cloned()
            .unwrap_or(json!("standard")),
    );
    output.insert(
        "log_category_levels".into(),
        stored
            .get("log_category_levels")
            .cloned()
            .unwrap_or(json!({})),
    );
    output.insert(
        "log_full".into(),
        stored.get("log_full").cloned().unwrap_or(Value::Null),
    );
}
pub(super) async fn apply(settings: &Value) -> Result<(), crate::gateway::GatewayApplicationError> {
    if let Some(log) = butler_log::global() {
        let log = log.clone();
        let config = butler_log::Config::from_settings(settings);
        if log.config().effective != config {
            tokio::task::spawn_blocking(move || log.configure(config))
                .await
                .map_err(crate::gateway::GatewayApplicationError::internal_from)?
                .map_err(crate::gateway::GatewayApplicationError::internal_from)?;
        }
    }
    Ok(())
}

/// Loads log preferences after instance admission, reverting a persisted full lease.
/// No App database is created before its normal storage owner starts.
pub fn startup_config(path: &std::path::Path) -> std::io::Result<butler_log::Config> {
    if !path.exists() {
        return Ok(butler_log::Config::default());
    }
    let db = butler_platform::sqlite::open(path).map_err(std::io::Error::other)?;
    let exists: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_settings')",
            [],
            |row| row.get(0),
        )
        .map_err(std::io::Error::other)?;
    if !exists {
        return Ok(butler_log::Config::default());
    }
    let mut settings = super::read_json(&db, super::SETTINGS_KEY)
        .map_err(std::io::Error::other)?
        .unwrap_or(json!({}));
    if settings["log_level"] == "full" {
        settings["log_level"] = settings
            .pointer("/log_full/previous")
            .filter(|v| **v != "full")
            .cloned()
            .unwrap_or(json!("standard"));
        settings["log_full"] = Value::Null;
        super::write_json(
            &db,
            super::SETTINGS_KEY,
            &settings,
            &chrono::Utc::now().to_rfc3339(),
        )
        .map_err(std::io::Error::other)?;
    }
    Ok(butler_log::Config::from_settings(&settings))
}
