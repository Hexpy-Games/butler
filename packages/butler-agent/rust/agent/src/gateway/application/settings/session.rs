use super::*;
use crate::btcc::{AccessMode, ReasoningEffort};
use crate::gateway::SessionControlState;
use rusqlite::OptionalExtension;

use super::super::AppSessionControlUpdate;

pub(in crate::gateway::application) struct SessionWorkspaceSettings {
    pub model: String,
    pub reasoning_effort: String,
    pub access_mode: String,
    pub plan_mode: bool,
    pub language: String,
    pub context_window_tokens: Option<u64>,
}

pub(in crate::gateway::application) fn session_context_settings(
    db: &Connection,
    subscribers: &EventSubscribers,
    facts: &AppSettingsFacts,
    chat_id: &str,
    now: &str,
) -> Result<SessionWorkspaceSettings, AppStorageError> {
    let settings = global_settings(db, subscribers, facts, now)?;
    let key = safe_local_session_id(chat_id);
    let explicit = read_json(db, &format!("session-controls-explicit:{key}"))?
        .and_then(|value| value.as_bool())
        == Some(true);
    let stored = explicit
        .then(|| read_json(db, &format!("session-controls:{key}")))
        .transpose()?
        .flatten()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let controls = inherited_controls(&settings, &stored, facts, explicit);
    let model_max = facts
        .known_models
        .iter()
        .find(|model| model.model_ref == controls.model)
        .and_then(|model| model.context_window_tokens)
        .unwrap_or(200_000);
    let context_window_tokens = (controls.model == settings.model)
        .then_some(settings.context_window_tokens)
        .flatten()
        .map(|value| value.clamp(1_000, model_max.max(1_000)));
    Ok(SessionWorkspaceSettings {
        model: controls.model,
        reasoning_effort: reasoning_name(&controls.reasoning).into(),
        access_mode: access_name(&controls.access).into(),
        plan_mode: controls.plan_mode,
        language: settings.language,
        context_window_tokens,
    })
}

pub(in crate::gateway::application) fn session_controls_view(
    db: &Connection,
    subscribers: &EventSubscribers,
    facts: &AppSettingsFacts,
    chat_id: &str,
    now: &str,
) -> Result<(SessionControlState, u64), AppStorageError> {
    require_chat(db, chat_id)?;
    let settings = session_context_settings(db, subscribers, facts, chat_id, now)?;
    let (_, _, revision_key) = session_control_keys(chat_id);
    Ok((
        SessionControlState {
            model: settings.model,
            reasoning_effort: settings.reasoning_effort,
            access_mode: settings.access_mode,
            plan_mode: settings.plan_mode,
        },
        revision(db, &revision_key)?,
    ))
}

pub(in crate::gateway::application) fn update_session_controls(
    db: &Connection,
    subscribers: &EventSubscribers,
    facts: &AppSettingsFacts,
    chat_id: &str,
    update: &AppSessionControlUpdate,
    now: &str,
) -> Result<(SessionControlState, u64), AppStorageError> {
    require_chat(db, chat_id)?;
    let current = session_context_settings(db, subscribers, facts, chat_id, now)?;
    let mut controls = Controls {
        model: current.model,
        reasoning: parse_reasoning(&current.reasoning_effort).unwrap_or(ReasoningEffort::Medium),
        access: parse_access(&current.access_mode).unwrap_or(AccessMode::FullAccess),
        plan_mode: current.plan_mode,
    };
    if let Some(model) = update.model.as_ref() {
        controls.model = model.clone();
    }
    if let Some(reasoning) = update.reasoning_effort.as_deref() {
        controls.reasoning = parse_reasoning(reasoning).ok_or_else(invalid_session_controls)?;
    }
    if let Some(access) = update.access_mode.as_deref() {
        controls.access = parse_access(access).ok_or_else(invalid_session_controls)?;
    }
    if let Some(plan_mode) = update.plan_mode {
        controls.plan_mode = plan_mode;
    }
    assert_selectable(&controls.model, available_models(facts))?;
    let controls = normalize_controls(controls, available_models(facts));
    let (controls_key, explicit_key, revision_key) = session_control_keys(chat_id);
    write_json(db, &controls_key, &controls_json(&controls), now)?;
    write_json(db, &explicit_key, &serde_json::Value::Bool(true), now)?;
    let revision = revision(db, &revision_key)?.saturating_add(1);
    write_json(db, &revision_key, &serde_json::Value::from(revision), now)?;
    append_controls_event(db, subscribers, chat_id, &controls, revision, facts, now)?;
    Ok((
        SessionControlState {
            model: controls.model,
            reasoning_effort: reasoning_name(&controls.reasoning).into(),
            access_mode: access_name(&controls.access).into(),
            plan_mode: controls.plan_mode,
        },
        revision,
    ))
}

fn session_control_keys(chat_id: &str) -> (String, String, String) {
    let key = safe_local_session_id(chat_id);
    (
        format!("session-controls:{key}"),
        format!("session-controls-explicit:{key}"),
        format!("session-controls-revision:{key}"),
    )
}

fn require_chat(db: &Connection, chat_id: &str) -> Result<(), AppStorageError> {
    let found = db
        .query_row("SELECT 1 FROM chats WHERE id=?1", [chat_id], |_| Ok(()))
        .optional()
        .map_err(AppStorageError::sqlite)?;
    found.ok_or_else(|| AppStorageError::new("session_not_found", "Session not found."))
}

fn invalid_session_controls() -> AppStorageError {
    AppStorageError::new(
        "invalid_session_controls",
        "Session controls update contains unsupported fields.",
    )
}

pub(in crate::gateway::application) fn session_workspace_settings(
    db: &Connection,
    subscribers: &EventSubscribers,
    facts: &AppSettingsFacts,
    now: &str,
) -> Result<SessionWorkspaceSettings, AppStorageError> {
    let settings = global_settings(db, subscribers, facts, now)?;
    Ok(SessionWorkspaceSettings {
        model: settings.model,
        reasoning_effort: reasoning_name(&settings.reasoning).into(),
        access_mode: access_name(&settings.access).into(),
        plan_mode: settings.plan_mode,
        language: settings.language,
        context_window_tokens: settings.context_window_tokens,
    })
}

fn reasoning_name(value: &ReasoningEffort) -> &'static str {
    match value {
        ReasoningEffort::None => "none",
        ReasoningEffort::Low => "low",
        ReasoningEffort::Medium => "medium",
        ReasoningEffort::High => "high",
        ReasoningEffort::Xhigh => "xhigh",
        ReasoningEffort::Max => "max",
    }
}

fn access_name(value: &AccessMode) -> &'static str {
    match value {
        AccessMode::FullAccess => "full_access",
        AccessMode::AskFirst => "ask_first",
        AccessMode::ReadOnly => "read_only",
    }
}
