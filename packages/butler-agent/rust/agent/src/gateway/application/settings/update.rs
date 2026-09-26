use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use super::{AppSettingsFacts, model, validation};
use crate::{gateway::GatewayApplicationError, public_text::trim_js_whitespace};

mod patch;

pub(super) const DEFAULT_PROJECT_WORKSPACE_SETTING_KEY: &str = "default-project-workspace-root";

pub(super) struct PreparedSettingsUpdate {
    pub patch: Value,
    pub projection: Value,
    pub workspace_root: Option<PathBuf>,
}

pub(super) fn prepare(
    input: &Value,
    current: &Value,
    facts: &AppSettingsFacts,
    current_workspace_root: &Path,
    resolve_workspace: impl FnOnce(&str) -> Result<PathBuf, GatewayApplicationError>,
) -> Result<PreparedSettingsUpdate, GatewayApplicationError> {
    if !validation::is_request(input) {
        return Err(invalid_settings());
    }
    let patch = patch::sanitize(input, facts);
    let workspace_root = input
        .get("default_project_folder_selection_token")
        .and_then(Value::as_str)
        .filter(|value| !trim_js_whitespace(value).is_empty())
        .map(resolve_workspace)
        .transpose()?;
    let projection = patch::project(
        current,
        &patch,
        facts,
        workspace_root.as_deref().unwrap_or(current_workspace_root),
    );
    Ok(PreparedSettingsUpdate {
        patch,
        projection,
        workspace_root,
    })
}

pub(super) fn project_after_refresh(
    current: &Value,
    patch: &Value,
    facts: &AppSettingsFacts,
    workspace_root: &std::path::Path,
) -> Value {
    patch::project(current, patch, facts, workspace_root)
}

pub(super) fn invalid_settings() -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 400,
        code: "invalid_settings_request".into(),
        message: "Settings update contains unsupported fields.".into(),
    }
}

pub(super) fn persistence_projection(projection: &Value) -> Value {
    let mut value = projection.as_object().cloned().unwrap_or_default();
    value.remove("model_fallback");
    Value::Object(value)
}

pub(super) fn event_payload(projection: &Value) -> Map<String, Value> {
    let enabled = projection
        .get("worker_profiles")
        .and_then(Value::as_array)
        .map(|profiles| {
            profiles
                .iter()
                .filter(|profile| profile.get("enabled").and_then(Value::as_bool) == Some(true))
                .count()
        })
        .unwrap_or(0);
    let fields = [
        "bridge_mode",
        "language",
        "model",
        "reasoning_effort",
        "timezone",
        "consolidation_model",
        "consolidation_reasoning_effort",
        "effective_consolidation_model",
        "context_window_tokens",
        "max_simultaneous_workers",
        "access_mode",
        "appearance_theme",
        "main_screen_theme",
        "main_screen_theme_preset",
        "translucent_sidebar",
        "smart_grouping_enabled",
        "desktop_notifications",
        "desktop_tray_enabled",
        "web_search",
        "model_fallback",
        "default_project_workspace_label",
    ];
    let mut settings = Map::new();
    for field in fields {
        if let Some(value) = projection.get(field) {
            settings.insert(field.into(), value.clone());
        }
    }
    settings.insert("enabled_worker_profile_count".into(), json!(enabled));
    let mut payload = Map::new();
    payload.insert("settings".into(), Value::Object(settings));
    payload
}

fn reasonings_for<'a>(
    model_ref: &str,
    facts: &'a AppSettingsFacts,
) -> (
    &'a [crate::btcc::ReasoningEffort],
    crate::btcc::ReasoningEffort,
) {
    let found = facts
        .known_models
        .iter()
        .chain(facts.registered_models.iter())
        .find(|value| value.model_ref == model_ref);
    found.map_or((&[], crate::btcc::ReasoningEffort::Medium), |value| {
        (
            &value.reasoning_efforts,
            value.default_reasoning_effort.clone(),
        )
    })
}

fn normalized_known_model(value: &str, facts: &AppSettingsFacts) -> Option<String> {
    let trimmed = trim_js_whitespace(value);
    let found = model::find_unique(trimmed, &facts.known_models)
        .or_else(|| model::find_unique(trimmed, &facts.registered_models))?;
    (found.runtime_supported && found.enabled).then(|| found.model_ref.clone())
}

pub(super) fn available_model_ref(value: &str, facts: &AppSettingsFacts) -> Option<String> {
    normalized_known_model(value, facts)
}

pub(super) fn normalize_model_fallback(
    input: &Value,
    current: &Value,
    primary: &str,
    facts: &AppSettingsFacts,
) -> Value {
    let input = input.as_object();
    let current = current.as_object();
    let enabled = input
        .and_then(|value| value.get("enabled"))
        .and_then(Value::as_bool)
        .or_else(|| {
            current
                .and_then(|value| value.get("enabled"))
                .and_then(Value::as_bool)
        })
        == Some(true);
    let mut models = Vec::new();
    let mut identities = Vec::<String>::new();
    let add_identity = |model: &crate::gateway::AppModelMetadata| {
        format!(
            "{}:{}",
            model
                .provider_family_id
                .as_deref()
                .unwrap_or(&model.provider_id),
            model.model_id
        )
    };
    if let Some(primary) = facts
        .known_models
        .iter()
        .chain(facts.registered_models.iter())
        .find(|value| value.model_ref == primary)
    {
        identities.push(add_identity(primary));
    }
    let requested = input
        .and_then(|value| value.get("models"))
        .and_then(Value::as_array)
        .or_else(|| {
            current
                .and_then(|value| value.get("models"))
                .and_then(Value::as_array)
        });
    if let Some(requested) = requested {
        for value in requested.iter().filter_map(Value::as_str) {
            let Some(model) = model::find_unique(value, &facts.registered_models) else {
                continue;
            };
            if !model.runtime_supported || !model.registered || !model.enabled {
                continue;
            }
            let identity = add_identity(model);
            if identities.contains(&identity) {
                continue;
            }
            identities.push(identity);
            models.push(model.model_ref.clone());
            if models.len() == 5 {
                break;
            }
        }
    }
    json!({"enabled":enabled,"models":models})
}
