//! Shared settings interpretation for global controls and App projections.

use rusqlite::Connection;
use serde_json::{Map, Value, json};

use super::worker_profiles;
use super::{
    AppSettingsFacts, EventSubscribers, SETTINGS_KEY, events, model,
    persistence::read_json,
    storage_helpers::{json_type, parse_access, safe_integer},
};
use crate::{
    btcc::{AccessMode, ReasoningEffort},
    gateway::{MessageSendRequest, application::storage::AppStorageError},
};

use super::persistence::write_json;
use model::{
    available as available_models, normalize as normalize_controls, parse_reasoning,
    resolve_primary, selectable,
};

pub(super) struct GlobalSettings {
    pub(super) model: String,
    pub(super) reasoning: ReasoningEffort,
    pub(super) access: AccessMode,
    pub(super) plan_mode: bool,
    pub(super) language: String,
    pub(super) context_window_tokens: Option<u64>,
}

pub(super) struct Controls {
    pub(super) model: String,
    pub(super) reasoning: ReasoningEffort,
    pub(super) access: AccessMode,
    pub(super) plan_mode: bool,
}

pub(super) fn global_settings(
    db: &Connection,
    subscribers: &EventSubscribers,
    facts: &AppSettingsFacts,
    now: &str,
) -> Result<GlobalSettings, AppStorageError> {
    let mut stored = read_json(db, SETTINGS_KEY)?
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    if stored.get("gateway_profile").and_then(Value::as_str) != Some("electron") {
        let previous = stored.get("gateway_profile").cloned();
        stored.insert("gateway_profile".into(), "electron".into());
        write_json(db, SETTINGS_KEY, &Value::Object(stored.clone()), now)?;
        let mut payload = Map::new();
        payload.insert("gateway_profile".into(), "electron".into());
        payload.insert(
            "previous_profile_kind".into(),
            json_type(previous.as_ref()).into(),
        );
        payload.insert("had_previous_profile".into(), previous.is_some().into());
        payload.insert("raw_text_included".into(), false.into());
        events::append(
            db,
            subscribers,
            "settings.gateway_profile_repaired",
            None,
            payload,
            now,
        )?;
    }
    let requested = stored
        .get("model")
        .and_then(Value::as_str)
        .or(facts.config_default_model.as_deref())
        .unwrap_or("openai/gpt-5.5");
    let metadata = resolve_primary(requested, facts);
    let requested_reasoning = stored
        .get("reasoning_effort")
        .and_then(Value::as_str)
        .and_then(parse_reasoning);
    let reasoning = requested_reasoning
        .filter(|value| metadata.reasoning_efforts.contains(value))
        .unwrap_or_else(|| metadata.default_reasoning_effort.clone());
    if worker_profiles::canonicalize(&mut stored, facts, &metadata.model_ref, &reasoning) {
        write_json(db, SETTINGS_KEY, &Value::Object(stored.clone()), now)?;
    }
    Ok(GlobalSettings {
        model: metadata.model_ref.clone(),
        reasoning,
        access: stored
            .get("access_mode")
            .and_then(Value::as_str)
            .and_then(parse_access)
            .unwrap_or(AccessMode::FullAccess),
        plan_mode: stored
            .get("plan_mode_default")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        language: stored
            .get("language")
            .and_then(Value::as_str)
            .filter(|value| matches!(*value, "en" | "ko"))
            .unwrap_or("en")
            .into(),
        context_window_tokens: stored
            .get("context_window_tokens")
            .and_then(safe_integer)
            .map(|value| value.max(1_000)),
    })
}

pub(super) fn inherited_controls(
    settings: &GlobalSettings,
    stored: &Map<String, Value>,
    facts: &AppSettingsFacts,
    explicit: bool,
) -> Controls {
    let stored_model = stored.get("model").and_then(Value::as_str);
    let candidate = Controls {
        model: stored_model.unwrap_or(&settings.model).to_owned(),
        reasoning: stored
            .get("reasoning_effort")
            .and_then(Value::as_str)
            .and_then(parse_reasoning)
            .unwrap_or_else(|| settings.reasoning.clone()),
        access: stored
            .get("access_mode")
            .and_then(Value::as_str)
            .and_then(parse_access)
            .unwrap_or_else(|| settings.access.clone()),
        plan_mode: stored
            .get("plan_mode")
            .and_then(Value::as_bool)
            .unwrap_or(settings.plan_mode),
    };
    if let Some(stored_model) = stored_model
        .filter(|_| explicit && selectable(&candidate.model, available_models(facts)).is_none())
    {
        let normalized = normalize_controls(
            Controls {
                model: settings.model.clone(),
                ..candidate
            },
            available_models(facts),
        );
        return Controls {
            model: stored_model.to_owned(),
            reasoning: stored
                .get("reasoning_effort")
                .and_then(Value::as_str)
                .and_then(parse_reasoning)
                .unwrap_or(normalized.reasoning),
            ..normalized
        };
    }
    normalize_controls(candidate, available_models(facts))
}

pub(super) fn merge_message_controls(controls: &mut Controls, request: &MessageSendRequest) {
    if let Some(value) = request.model.as_ref().and_then(Value::as_str) {
        controls.model = value.to_owned();
    }
    if let Some(value) = request
        .reasoning_effort
        .as_ref()
        .and_then(Value::as_str)
        .and_then(parse_reasoning)
    {
        controls.reasoning = value;
    }
    if let Some(value) = request
        .access_mode
        .as_ref()
        .and_then(Value::as_str)
        .and_then(parse_access)
    {
        controls.access = value;
    }
    if let Some(value) = request.plan_mode.as_ref().and_then(Value::as_bool) {
        controls.plan_mode = value;
    }
}

pub(super) fn append_controls_event(
    db: &Connection,
    subscribers: &EventSubscribers,
    chat_id: &str,
    controls: &Controls,
    revision: u64,
    facts: &AppSettingsFacts,
    now: &str,
) -> Result<(), AppStorageError> {
    let mut payload = controls_json(controls).as_object().unwrap().clone();
    payload.insert("session_id".into(), chat_id.into());
    payload.insert("revision".into(), revision.into());
    payload.insert(
        "catalog_generation".into(),
        facts.catalog_generation.clone().into(),
    );
    events::append(
        db,
        subscribers,
        "session.controls_updated",
        None,
        payload,
        now,
    )?;
    Ok(())
}
pub(super) fn controls_json(value: &Controls) -> Value {
    json!({
        "model": value.model,
        "reasoning_effort": value.reasoning,
        "access_mode": value.access,
        "plan_mode": value.plan_mode,
    })
}
pub(super) fn has_message_override(request: &MessageSendRequest) -> bool {
    request.model.is_some()
        || request.reasoning_effort.is_some()
        || request.access_mode.is_some()
        || request.plan_mode.is_some()
}
