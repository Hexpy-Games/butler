//! Stored browsing preference and a projection of refresh-owned auto resolution.
use super::AppSettingsFacts;
use crate::gateway::GatewayApplicationError;
use serde_json::{Map, Value, json};

pub(super) fn valid(input: &Value) -> bool {
    input.get("browser").is_none_or(|value| {
        value.as_object().is_some_and(|object| {
            object
                .iter()
                .all(|(key, value)| key == "browsing_agent" && value.is_string())
        })
    })
}

pub(super) fn sanitize(
    input: &Value,
    facts: &AppSettingsFacts,
    patch: &mut Value,
) -> Result<(), GatewayApplicationError> {
    let Some(value) = input
        .pointer("/browser/browsing_agent")
        .and_then(Value::as_str)
    else {
        return Ok(());
    };
    if !matches!(value, "auto" | "off")
        && !facts.registered_models.iter().any(|model| {
            model.model_ref == value && model.registered && model.enabled && model.runtime_supported
        })
    {
        return Err(super::update::model_unavailable("browser.browsing_agent"));
    }
    patch["browser"] = json!({"browsing_agent": value});
    Ok(())
}

pub(super) fn project(
    current: &Value,
    patch: &Value,
    facts: &AppSettingsFacts,
    output: &mut Value,
) {
    let value = patch
        .pointer("/browser/browsing_agent")
        .or_else(|| current.pointer("/browser/browsing_agent"))
        .cloned()
        .unwrap_or(json!("off"));
    if let Some(object) = output.as_object_mut() {
        object.insert("browser".into(), json!({"browsing_agent": value}));
        view(&Map::new(), facts, object);
    }
}

pub(super) fn view(
    stored: &Map<String, Value>,
    facts: &AppSettingsFacts,
    output: &mut Map<String, Value>,
) {
    let value = output
        .get("browser")
        .or_else(|| stored.get("browser"))
        .and_then(|browser| browser.get("browsing_agent"))
        .cloned()
        .unwrap_or(json!("off"));
    let model = output
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut auto = facts.native_settings["browsing_auto"]
        .get(model)
        .cloned()
        .unwrap_or_else(|| json!({"model": model, "rule": "conversation"}));
    if auto["rule"] == "conversation" {
        auto["effort"] = output
            .get("reasoning_effort")
            .cloned()
            .unwrap_or(json!("medium"));
    }
    output.insert(
        "browser".into(),
        json!({"browsing_agent": value, "auto": auto}),
    );
}

/// Read the indexed App preference on a blocking worker; absent settings use Off.
pub async fn browsing_agent_setting(
    path: std::path::PathBuf,
) -> Result<String, GatewayApplicationError> {
    use rusqlite::{OpenFlags, OptionalExtension};
    tokio::task::spawn_blocking(move || {
        let db = butler_platform::sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        let setting: Option<Option<String>> = db.query_row(
            "SELECT json_extract(value_json, '$.browser.browsing_agent') FROM app_settings WHERE key='settings'",
            [], |row| row.get(0),
        ).optional()?;
        Ok::<_, rusqlite::Error>(setting.flatten().unwrap_or_else(|| "off".into()))
    }).await.map_err(GatewayApplicationError::internal_from)?
        .map_err(GatewayApplicationError::internal_from)
}
