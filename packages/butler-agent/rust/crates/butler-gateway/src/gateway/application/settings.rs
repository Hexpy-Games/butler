//! App-owned global and per-session execution-control resolution.

use std::{path::Path, sync::Arc};

use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};

mod access;
mod controls;
mod default_model;
mod model;
mod onboarding;
mod persistence;
mod plan_continuation;
mod session;
mod storage_helpers;
mod update;
mod validation;
mod view;
mod wallpaper;
mod worker_profiles;

use super::wallpapers::{self, WallpaperOrigin};
use super::{AppSettingsFacts, EventSubscribers, events, storage::AppStorageError};
use crate::gateway::{AppWallpaperScope, MessageSendRequest};
use butler_core::public_text::trim_js_whitespace;
use butler_turn::btcc::{ControlResolution, ControlSource};
use controls::{
    Controls, append_controls_event, controls_json, global_settings, has_message_override,
    inherited_controls, merge_message_controls,
};
use model::{
    assert_selectable, available as available_models, normalize as normalize_controls,
    normalized_fallback, parse_reasoning,
};
use persistence::{read_json, revision, safe_local_session_id, write_json};
use storage_helpers::{invalid_resolution, parse_access, safe_integer};

const SETTINGS_KEY: &str = "settings";

/// Read the App-owned preference without starting or mutating the App service.
/// Missing or unreadable settings leave diagnostics disabled.
pub fn diagnostics_enabled_readonly(database_path: &Path) -> bool {
    let Ok(db) = Connection::open_with_flags(database_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
    else {
        return false;
    };
    read_json(&db, SETTINGS_KEY)
        .ok()
        .flatten()
        .and_then(|settings| settings.get("diagnostics_enabled").and_then(Value::as_bool))
        == Some(true)
}

pub(super) struct ResolvedControls {
    pub resolution: ControlResolution,
    pub persisted: Value,
}
pub(super) use access::{
    access_mode_name, conversation_access_mode, default_access_mode, record_default_access_mode,
};
pub(super) use default_model::record_default_model_policy;
pub(super) use plan_continuation::{
    PlanContinuation, PlanInstruction, create_plan_continuation, create_plan_instruction,
};
pub(super) use wallpaper::{
    check_agent_source as check_agent_wallpaper_source, check_project as check_project_wallpaper,
    project_unknown_asset as unknown_project_wallpaper, project_view as project_wallpaper_view,
    source_image_asset,
};

/// The stored global `wallpaper.source`, if a settings write stored one.
pub(super) fn stored_wallpaper_source(db: &Connection) -> Result<Option<Value>, AppStorageError> {
    Ok(read_json(db, SETTINGS_KEY)?
        .and_then(|settings| settings.get(wallpaper::KEY)?.get("source").cloned()))
}

pub(super) use session::{
    SessionWorkspaceSettings, session_context_settings, session_controls_view,
    session_workspace_settings, update_session_controls,
};
pub(super) use view::ui_language;

pub(super) fn resolve_for_message_send(
    db: &Connection,
    subscribers: &EventSubscribers,
    chat_id: &str,
    request: &MessageSendRequest,
    facts: &Arc<AppSettingsFacts>,
    now: &str,
) -> Result<ResolvedControls, AppStorageError> {
    let settings = global_settings(db, subscribers, facts, now)?;
    let key = safe_local_session_id(chat_id);
    let controls_key = format!("session-controls:{key}");
    let explicit_key = format!("session-controls-explicit:{key}");
    let revision_key = format!("session-controls-revision:{key}");
    let explicit = read_json(db, &explicit_key)?.and_then(|v| v.as_bool()) == Some(true);
    let stored = explicit
        .then(|| read_json(db, &controls_key))
        .transpose()?
        .flatten()
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    let mut controls = inherited_controls(&settings, &stored, facts, explicit);
    // A per-message override applies to this message only: the session keeps
    // its own controls (PATCH /sessions/{id}/controls changes those).
    let message_override = has_message_override(request);
    if message_override {
        merge_message_controls(&mut controls, request);
        assert_selectable(&controls.model, available_models(facts))?;
        controls = normalize_controls(controls, available_models(facts));
    }
    assert_selectable(&controls.model, available_models(facts))?;
    let revision = revision(db, &revision_key)?;
    let source = if message_override {
        ControlSource::MessageOverride
    } else if explicit {
        ControlSource::SessionOverride
    } else {
        ControlSource::GlobalDefault
    };
    let fallback = normalized_fallback(facts, &settings.model);
    let mut persisted = json!({
        "controls": controls_json(&controls),
        "model_fallback": {"enabled":fallback.enabled,"models":fallback.models},
        "source": source,
        "sessionControlRevision": revision,
        "catalogGeneration": facts.catalog_generation,
    });
    // A queued or replayed delegated result must keep its marker (the only
    // thing that hides it from the chat) when the turn is rebuilt from here.
    if let Some(result) = &request.subsession_result {
        persisted["subsession_result"] = json!(result);
    }
    Ok(ResolvedControls {
        resolution: ControlResolution {
            model: controls.model,
            reasoning_effort: controls.reasoning,
            access_mode: controls.access,
            plan_mode: controls.plan_mode,
            source,
            session_control_revision: revision,
            catalog_generation: facts.catalog_generation.clone(),
            model_fallback: Some(fallback),
            subsession_result: request.subsession_result.clone(),
        },
        persisted,
    })
}

pub(super) fn resolution_from_persisted(value: &str) -> Result<ControlResolution, AppStorageError> {
    let value: Value =
        serde_json::from_str(value).map_err(|source| invalid_resolution().with_source(source))?;
    let object = value.as_object().ok_or_else(invalid_resolution)?;
    let controls = object
        .get("controls")
        .and_then(Value::as_object)
        .ok_or_else(invalid_resolution)?;
    let model = controls
        .get("model")
        .and_then(Value::as_str)
        .filter(|value| !trim_js_whitespace(value).is_empty())
        .ok_or_else(invalid_resolution)?
        .to_owned();
    let reasoning_effort = controls
        .get("reasoning_effort")
        .and_then(Value::as_str)
        .and_then(parse_reasoning)
        .ok_or_else(invalid_resolution)?;
    let access_mode = controls
        .get("access_mode")
        .and_then(Value::as_str)
        .and_then(parse_access)
        .ok_or_else(invalid_resolution)?;
    let plan_mode = controls
        .get("plan_mode")
        .and_then(Value::as_bool)
        .ok_or_else(invalid_resolution)?;
    let source = match object.get("source").and_then(Value::as_str) {
        Some("message_override") => ControlSource::MessageOverride,
        Some("session_override") => ControlSource::SessionOverride,
        Some("global_default") => ControlSource::GlobalDefault,
        _ => return Err(invalid_resolution()),
    };
    let session_control_revision = object
        .get("sessionControlRevision")
        .and_then(safe_integer)
        .ok_or_else(invalid_resolution)?;
    let catalog_generation = object
        .get("catalogGeneration")
        .and_then(Value::as_str)
        .ok_or_else(invalid_resolution)?
        .to_owned();
    let model_fallback = object
        .get("model_fallback")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|source| invalid_resolution().with_source(source))?;
    let subsession_result = object
        .get("subsession_result")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|source| invalid_resolution().with_source(source))?;
    Ok(ControlResolution {
        model,
        reasoning_effort,
        access_mode,
        plan_mode,
        source,
        session_control_revision,
        catalog_generation,
        model_fallback,
        subsession_result,
    })
}

impl super::AppApplication {
    pub(super) async fn briefing_language(
        &self,
    ) -> Result<String, crate::gateway::GatewayApplicationError> {
        let facts = self.dependencies.settings_facts.snapshot()?;
        self.storage
            .read(move |db| Ok(controls::global_settings_readonly(db, &facts)?.language))
            .await
            .map_err(super::app_error)
    }

    pub(super) async fn worker_profile_settings(
        &self,
    ) -> Result<Value, crate::gateway::GatewayApplicationError> {
        self.dependencies.settings_facts.refresh().await?;
        let facts = self.dependencies.settings_facts.snapshot()?;
        let now = self.dependencies.identity_clock.now_iso();
        let workspace_root = self.project_creation.workspace_root();
        let subscribers = self.subscribers.clone();
        self.storage
            .read(move |db| view::read(db, &subscribers, &facts, &now, &workspace_root))
            .await
            .map_err(super::app_error)
    }

    pub(super) async fn update_settings_owned(
        &self,
        input: Value,
    ) -> Result<Value, crate::gateway::GatewayApplicationError> {
        self.update_settings_from(input, WallpaperOrigin::User)
            .await
            .map(|(_, projection)| projection)
    }

    /// Applies a settings PATCH from `origin`. Returns the effective
    /// `wallpaper.source` before the write and the new projection; a changed
    /// source also appends `wallpaper.changed`.
    pub(super) async fn update_settings_from(
        &self,
        input: Value,
        origin: WallpaperOrigin,
    ) -> Result<(Value, Value), crate::gateway::GatewayApplicationError> {
        let _update = self.settings_update_lock.lock().await;
        self.dependencies.settings_facts.refresh().await?;
        let facts = self.dependencies.settings_facts.snapshot()?;
        let current_root = self.project_creation.workspace_root();
        let view_root = current_root.clone();
        let view_facts = facts.clone();
        let subscribers = self.subscribers.clone();
        let now = self.dependencies.identity_clock.now_iso();
        let current = self
            .storage
            .execute(move |db| view::read(db, &subscribers, &view_facts, &now, &view_root))
            .await
            .map_err(super::app_error)?;

        let prepared = update::prepare(&input, &current, &facts, &current_root, |token| {
            self.project_creation.resolve_workspace_selection(token)
        })?;
        if let Some(asset) = wallpaper::patched_image_asset(&prepared.patch)
            && !self.wallpaper_asset_exists(asset.to_owned()).await?
        {
            return Err(wallpaper::unknown_asset());
        }
        self.dependencies
            .settings_mutations
            .apply(prepared.patch.clone(), prepared.projection)
            .await?;
        self.dependencies.settings_facts.refresh().await?;
        let refreshed = self.dependencies.settings_facts.snapshot()?;
        let workspace_root = prepared.workspace_root.unwrap_or(current_root);
        let projection =
            update::project_after_refresh(&current, &prepared.patch, &refreshed, &workspace_root);
        let stored_projection = update::persistence_projection(&projection);
        let event_payload = update::event_payload(&projection);
        let previous = wallpaper::source(&current);
        let wallpaper_event = wallpapers::change_payload(
            AppWallpaperScope::Global,
            None,
            &previous,
            &wallpaper::source(&projection),
            origin,
        );
        let root_changed = workspace_root != self.project_creation.workspace_root();
        let persisted_root = workspace_root.clone();
        let now = self.dependencies.identity_clock.now_iso();
        let subscribers = self.subscribers.clone();
        self.storage
            .execute(move |db| {
                write_json(db, SETTINGS_KEY, &stored_projection, &now)?;
                events::append(
                    db,
                    &subscribers,
                    "settings.updated",
                    None,
                    event_payload,
                    &now,
                )?;
                if let Some(payload) = wallpaper_event {
                    events::append(db, &subscribers, wallpapers::CHANGED, None, payload, &now)?;
                }
                if root_changed {
                    write_json(
                        db,
                        update::DEFAULT_PROJECT_WORKSPACE_SETTING_KEY,
                        &json!(persisted_root.to_string_lossy()),
                        &now,
                    )?;
                }
                Ok(())
            })
            .await
            .map_err(super::app_error)?;
        self.project_creation.set_workspace_root(workspace_root);
        Ok((previous, projection))
    }
}
