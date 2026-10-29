//! App-owned global and per-session execution-control resolution.

use std::sync::Arc;

use rusqlite::Connection;
use serde_json::{Value, json};

mod access;
mod browsing;
pub use browsing::browsing_agent_setting;
mod command_sandbox;
mod logging;
pub use command_sandbox::command_sandbox_enabled;
pub use logging::{producer_config as producer_log_config, startup_config as startup_log_config};
mod background_sources;
mod composer_decoration;
mod controls;
mod conversation_background;
mod default_model;
mod model;
mod onboarding;
pub(super) mod persistence;
mod plan_continuation;
mod proactive;
mod readonly;
mod timezone;
pub use readonly::{diagnostics_enabled_readonly, stored_ui_language_readonly};
pub(super) use timezone::effective_timezone;
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
pub(super) use model::selectable_model_ref;
use model::{
    assert_selectable, available as available_models, normalize as normalize_controls,
    normalized_fallback, parse_reasoning,
};
use persistence::{read_json, revision, safe_local_session_id, write_json};
use storage_helpers::{invalid_resolution, parse_access, safe_integer};

const SETTINGS_KEY: &str = "settings";

pub(super) struct ResolvedControls {
    pub resolution: ControlResolution,
    pub persisted: Value,
}
pub(super) use access::{
    access_mode_name, conversation_access_mode, default_access_mode, record_default_access_mode,
    schedule_access_mode,
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

/// Stored sources for both global surfaces, read from one indexed settings row.
pub(super) fn stored_background_sources(
    db: &Connection,
) -> Result<Vec<(String, Value)>, AppStorageError> {
    let settings = read_json(db, SETTINGS_KEY)?.unwrap_or(Value::Null);
    Ok([wallpaper::KEY, conversation_background::KEY]
        .into_iter()
        .filter_map(|key| {
            Some((
                format!("settings.{key}"),
                settings.get(key)?.get("source")?.clone(),
            ))
        })
        .collect())
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
    let mut controls = inherited_controls(&settings, &stored, facts);
    // A per-message override applies to this message only: the session keeps
    // its own controls (PATCH /sessions/{id}/controls changes those).
    let message_override = has_message_override(request);
    if message_override {
        merge_message_controls(&mut controls, request);
        assert_selectable(&controls.model, &available_models(facts))?;
        controls = normalize_controls(controls, &available_models(facts));
    }
    assert_selectable(&controls.model, &available_models(facts))?;
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
    if let Some(run) = &request.schedule_run {
        persisted["schedule_run"] = json!(run);
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
            schedule_run: request.schedule_run.clone(),
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
    fn optional<T: serde::de::DeserializeOwned>(
        object: &serde_json::Map<String, Value>,
        key: &str,
    ) -> Result<Option<T>, AppStorageError> {
        object
            .get(key)
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .map_err(|source| invalid_resolution().with_source(source))
    }
    let subsession_result = optional(object, "subsession_result")?;
    let schedule_run = optional(object, "schedule_run")?;
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
        schedule_run,
    })
}

impl super::AppApplication {
    pub(super) async fn initialize_thinking_preference(
        &self,
    ) -> Result<(), crate::gateway::GatewayApplicationError> {
        let enabled = self
            .storage
            .read(|db| {
                Ok(read_json(db, SETTINGS_KEY)?
                    .is_some_and(|settings| settings["show_thinking"] == true))
            })
            .await
            .map_err(super::app_error)?;
        self.subscribers.set_thinking_enabled(enabled);
        Ok(())
    }

    pub(super) async fn briefing_language(
        &self,
    ) -> Result<String, crate::gateway::GatewayApplicationError> {
        let facts = self.dependencies.settings_facts.snapshot()?;
        self.storage
            .read(move |db| Ok(controls::global_settings_readonly(db, &facts)?.language))
            .await
            .map_err(super::app_error)
    }

    pub(super) async fn resolve_settings_projection(
        &self,
        settings: Value,
    ) -> Result<Value, crate::gateway::GatewayApplicationError> {
        let mut settings = self.resolve_background_sources(settings).await?;
        if let Some(port) = &self.dependencies.data_reset {
            settings["data_generation"] = port.generation().into();
        }
        Ok(settings)
    }

    pub(super) async fn worker_profile_settings(
        &self,
    ) -> Result<Value, crate::gateway::GatewayApplicationError> {
        self.dependencies.settings_facts.refresh().await?;
        let facts = self.dependencies.settings_facts.snapshot()?;
        let now = self.dependencies.identity_clock.now_iso();
        let workspace_root = self.project_creation.workspace_root();
        let subscribers = self.subscribers.clone();
        let view = self
            .storage
            .read(move |db| view::read(db, &subscribers, &facts, &now, &workspace_root))
            .await
            .map_err(super::app_error)?;
        self.resolve_settings_projection(view).await
    }

    pub(super) async fn update_settings_owned(
        &self,
        input: Value,
    ) -> Result<Value, crate::gateway::GatewayApplicationError> {
        let (_, projection) = self
            .update_settings_from(input, WallpaperOrigin::User)
            .await?;
        logging::apply(&projection).await?;
        Ok(projection)
    }

    /// Applies a settings PATCH from `origin`. Returns the effective
    /// `wallpaper.source` before the write and the new projection; a changed
    /// source also appends `wallpaper.changed`.
    pub(super) async fn update_settings_from(
        &self,
        input: Value,
        origin: WallpaperOrigin,
    ) -> Result<(Value, Value), crate::gateway::GatewayApplicationError> {
        let timing = crate::gateway::command_timing::CommandTiming::new("settings_patch");
        let update_guard = self.settings_update_lock.lock().await;
        timing.mark("lock_acquired");
        self.dependencies.settings_facts.refresh().await?;
        timing.mark("facts_refreshed");
        let facts = self.dependencies.settings_facts.snapshot()?;
        let current_root = self.project_creation.workspace_root();
        let view_root = current_root.clone();
        let view_facts = facts.clone();
        let subscribers = self.subscribers.clone();
        let now = self.dependencies.identity_clock.now_iso();
        let current = self
            .storage
            .read(move |db| view::read(db, &subscribers, &view_facts, &now, &view_root))
            .await
            .map_err(super::app_error)?;

        let selected = self.resolve_folder_selection(&input).await?;
        let prepared = update::prepare(&input, &current, &facts, &current_root, |_| {
            selected.ok_or_else(crate::gateway::GatewayApplicationError::internal)
        })?;
        self.validate_wallpaper_patch(&prepared.patch).await?;
        timing.mark("patch_prepared");
        if prepared.workspace_root.is_none()
            && update::unchanged_preferences(&prepared.patch, &current)
        {
            return Ok((
                wallpaper::source(&current),
                self.resolve_settings_projection(current).await?,
            ));
        }
        self.dependencies
            .settings_mutations
            .apply(prepared.patch.clone(), prepared.projection)
            .await?;
        timing.mark("mutation_applied");
        self.dependencies.settings_facts.refresh().await?;
        timing.mark("facts_reloaded");
        let refreshed = self.dependencies.settings_facts.snapshot()?;
        let workspace_root = prepared.workspace_root.unwrap_or(current_root);
        let projection =
            update::project_after_refresh(&current, &prepared.patch, &refreshed, &workspace_root);
        let stored_projection = update::persistence_projection(&projection);
        let projection = self.resolve_settings_projection(projection).await?;
        let event_payload = update::event_payload(&projection);
        let previous = wallpaper::source(&current);
        let wallpaper_event = wallpapers::change_payload(
            AppWallpaperScope::Global,
            None,
            &previous,
            &wallpaper::source(&projection),
            origin,
        );
        let root = (workspace_root != self.project_creation.workspace_root())
            .then(|| workspace_root.clone());
        let schedule_mode_chosen = prepared.patch.get("schedule_access_mode").is_some();
        self.persist_settings_update(
            (stored_projection, schedule_mode_chosen),
            event_payload,
            wallpaper_event,
            root,
        )
        .await?;
        self.project_creation.set_workspace_root(workspace_root);
        drop(update_guard);
        if let Err(error) = self
            .dependencies
            .subsessions
            .worker_settings_changed()
            .await
        {
            butler_core::diagnostic!("[gateway] Worker settings admission deferred: {error}");
        }
        Ok((previous, projection))
    }

    async fn persist_settings_update(
        &self,
        (mut stored_projection, schedule_mode_chosen): (Value, bool),
        event_payload: serde_json::Map<String, Value>,
        wallpaper_event: Option<serde_json::Map<String, Value>>,
        root: Option<std::path::PathBuf>,
    ) -> Result<(), crate::gateway::GatewayApplicationError> {
        let now = self.dependencies.identity_clock.now_iso();
        let subscribers = self.subscribers.clone();
        self.storage
            .execute(move |db| {
                // The view resolves the schedule default (D7); store it only once
                // the user chose one, so an unsaved default keeps following the
                // conversation default.
                let saved = read_json(db, SETTINGS_KEY)?
                    .is_some_and(|stored| stored.get("schedule_access_mode").is_some());
                if !schedule_mode_chosen
                    && !saved
                    && let Some(fields) = stored_projection.as_object_mut()
                {
                    fields.remove("schedule_access_mode");
                }
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
                if let Some(persisted_root) = root {
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
            .map_err(super::app_error)
    }

    async fn resolve_folder_selection(
        &self,
        input: &Value,
    ) -> Result<Option<std::path::PathBuf>, crate::gateway::GatewayApplicationError> {
        let Some(token) = input
            .get("default_project_folder_selection_token")
            .and_then(Value::as_str)
            .filter(|token| !butler_core::public_text::trim_js_whitespace(token).is_empty())
        else {
            return Ok(None);
        };
        let token = token.to_owned();
        let owner = self.project_creation.clone();
        let data = self.butler_data.clone();
        tokio::task::spawn_blocking(move || owner.resolve_workspace_selection(&token, &data))
            .await
            .map_err(crate::gateway::GatewayApplicationError::internal_from)?
            .map(Some)
    }

    async fn validate_wallpaper_patch(
        &self,
        patch: &Value,
    ) -> Result<(), crate::gateway::GatewayApplicationError> {
        if let Some(asset) = wallpaper::patched_image_asset(patch)
            && !self.wallpaper_asset_exists(asset.to_owned()).await?
        {
            return Err(wallpaper::unknown_asset());
        }
        if let Some(asset) = patch
            .get(conversation_background::KEY)
            .and_then(|v| v.get("source"))
            .and_then(wallpaper::source_image_asset)
            && !self.wallpaper_asset_exists(asset.to_owned()).await?
        {
            return Err(conversation_background::invalid(
                "source.asset must name a stored wallpaper image",
            ));
        }
        Ok(())
    }
}
