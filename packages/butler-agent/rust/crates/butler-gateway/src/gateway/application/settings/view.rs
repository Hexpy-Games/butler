use std::path::Path;

use rusqlite::Connection;
use serde_json::{Map, Value, json};

use super::{
    AppSettingsFacts, EventSubscribers, SETTINGS_KEY, global_settings, model,
    onboarding::{KEY, view as onboarding_view},
    persistence::read_json,
    wallpaper,
};
mod normalize;
use crate::gateway::application::storage::AppStorageError;
use crate::gateway::ui_language::UiLanguage;
use normalize::{
    enum_value, integer, language, main_colors, main_preset, main_theme, multiline, native_value,
    notifications, object, timezone, ui_defaults, workspace_label,
};

/// The language the App shows (`language` of the settings view): Settings,
/// else `user.language` of butler.config.json, else English.
pub(in crate::gateway::application) fn ui_language(
    db: &Connection,
    facts: &AppSettingsFacts,
) -> Result<UiLanguage, AppStorageError> {
    let stored = read_json(db, SETTINGS_KEY)?
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let native = facts
        .native_settings
        .as_object()
        .cloned()
        .unwrap_or_default();
    Ok(language(
        stored.get("language"),
        native_value(&native, "config_user").get("language"),
    ))
}

pub(super) fn read(
    db: &Connection,
    subscribers: &EventSubscribers,
    facts: &AppSettingsFacts,
    now: &str,
    workspace_root: &Path,
) -> Result<Value, AppStorageError> {
    let controls = global_settings(db, subscribers, facts, now)?;
    let stored = stored_settings(db, facts, &controls)?;
    let native = facts
        .native_settings
        .as_object()
        .cloned()
        .unwrap_or_default();
    let config_user = native_value(&native, "config_user");
    let config_web = native_value(&native, "web_search");
    let external = native_value(&native, "web_search_credentials");
    let configured_web = object(config_web);
    let stored_web = stored.get("web_search").and_then(Value::as_object);
    let provider = enum_value(
        stored_web
            .and_then(|value| value.get("provider"))
            .or_else(|| configured_web.get("provider")),
        &[
            "duckduckgo-html",
            "auto",
            "brave",
            "tavily",
            "openai-web-search",
            "codex-subscription-web-search",
            "disabled",
        ],
        "duckduckgo-html",
    );
    let credential = object(external)
        .get(&provider)
        .cloned()
        .unwrap_or(Value::Null);
    let api_key_configured = credential.get("configured").and_then(Value::as_bool) == Some(true);
    let api_key_env_var = credential
        .get("env_var")
        .cloned()
        .filter(|value| !value.is_null())
        .unwrap_or(Value::Null);
    let planning_enabled = stored_web
        .and_then(|value| value.get("planning_enabled"))
        .and_then(Value::as_bool)
        .or_else(|| {
            configured_web
                .get("planning_enabled")
                .and_then(Value::as_bool)
        })
        .or_else(|| {
            (configured_web.get("planning_mode").and_then(Value::as_str) != Some("off"))
                .then_some(true)
        })
        .unwrap_or(true);
    let web_search = json!({
        "provider":provider,
        "reader_backend":enum_value(
            stored_web.and_then(|value| value.get("reader_backend")).or_else(|| configured_web.get("reader_backend")),
            &["lightweight", "auto", "lightpanda", "jina-hosted", "disabled"],
            "lightweight",
        ),
        "api_key_configured":api_key_configured,
        "api_key_env_var":api_key_env_var,
        "planning_enabled":planning_enabled,
        "planning_default_depth":enum_value(
            stored_web.and_then(|value| value.get("planning_default_depth")).or_else(|| configured_web.get("planning_default_depth")),
            &["quick", "balanced", "deep"],
            "balanced",
        ),
    });
    let model_fallback = model::normalized_fallback(facts, &controls.model);
    let max_context = facts
        .known_models
        .iter()
        .find(|value| value.model_ref == controls.model)
        .and_then(|value| value.context_window_tokens)
        .unwrap_or(258_000);
    let context_window = stored
        .get("context_window_tokens")
        .and_then(integer)
        .unwrap_or(258_000.min(max_context))
        .min(max_context)
        .max(1_000);
    let mut output = recall_defaults(&stored);
    project_native_preferences(&native, &mut output);
    output.insert(KEY.into(), onboarding_view(&stored));
    output.insert(
        "server_url".into(),
        stored
            .get("server_url")
            .filter(|value| value.as_str().is_some())
            .cloned()
            .unwrap_or_else(|| native.get("server_url").cloned().unwrap_or(Value::Null)),
    );
    output.insert(
        "default_project_workspace_label".into(),
        json!(workspace_label(workspace_root)),
    );
    output.insert(
        "language".into(),
        json!(language(stored.get("language"), config_user.get("language")).as_str()),
    );
    output.insert(
        "timezone".into(),
        json!(timezone(
            stored
                .get("timezone")
                .or_else(|| config_user.get("timezone")),
            native.get("local_timezone")
        )),
    );
    output.insert("model".into(), json!(controls.model.clone()));
    output.insert("reasoning_effort".into(), json!(controls.reasoning));
    let consolidation = native.get("consolidation").map(object).unwrap_or_default();
    let configured_consolidation = consolidation
        .get("model")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("default");
    let effective_consolidation = consolidation
        .get("effective_model")
        .and_then(Value::as_str)
        .unwrap_or(&controls.model);
    let uses_butler = consolidation
        .get("uses_butler_model")
        .and_then(Value::as_bool)
        == Some(true);
    output.insert(
        "consolidation_model".into(),
        json!(configured_consolidation),
    );
    output.insert(
        "consolidation_reasoning_effort".into(),
        json!(
            consolidation
                .get("reasoning_effort")
                .and_then(Value::as_str)
                .unwrap_or("xhigh")
        ),
    );
    output.insert(
        "effective_consolidation_model".into(),
        json!(if uses_butler {
            controls.model.as_str()
        } else {
            effective_consolidation
        }),
    );
    output.insert("consolidation_uses_butler_model".into(), json!(uses_butler));
    output.insert("context_window_tokens".into(), json!(context_window));
    output.insert(
        "worker_profiles".into(),
        stored
            .get("worker_profiles")
            .filter(|value| value.is_array())
            .cloned()
            .unwrap_or_else(|| json!([])),
    );
    output.insert(
        "max_simultaneous_workers".into(),
        stored
            .get("max_simultaneous_workers")
            .filter(|value| (1..=10).contains(&integer(value).unwrap_or(0)))
            .cloned()
            .unwrap_or(json!(10)),
    );
    output.insert(
        "access_mode".into(),
        json!(super::access_mode_name(&controls.access)),
    );
    output.insert(
        "plan_mode_default".into(),
        json!(
            stored
                .get("plan_mode_default")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        ),
    );
    output.insert(
        "follow_up_behavior".into(),
        json!(enum_value(
            stored.get("follow_up_behavior"),
            &["queue", "steer"],
            "queue"
        )),
    );
    output.insert(
        "multiline_send_behavior".into(),
        json!(multiline(stored.get("multiline_send_behavior"))),
    );
    output.insert(
        "appearance_theme".into(),
        json!(enum_value(
            stored.get("appearance_theme"),
            &["system", "light", "dark"],
            "system"
        )),
    );
    main_screen(&stored, &mut output);
    output.insert(
        "translucent_sidebar".into(),
        json!(
            stored
                .get("translucent_sidebar")
                .and_then(Value::as_bool)
                .unwrap_or(true)
        ),
    );
    output.insert(
        "smart_grouping_enabled".into(),
        json!(
            stored
                .get("smart_grouping_enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true)
        ),
    );
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
        "desktop_notifications".into(),
        notifications(stored.get("desktop_notifications")),
    );
    output.insert(
        "desktop_tray_enabled".into(),
        json!(
            stored
                .get("desktop_tray_enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true)
        ),
    );
    output.insert("web_search".into(), web_search);
    output.insert(
        "model_fallback".into(),
        json!({"enabled":model_fallback.enabled,"models":model_fallback.models}),
    );
    Ok(Value::Object(output))
}
/// The legacy main-screen keys, normalized, and the `wallpaper` setting, which
/// they describe until a PATCH stores one.
fn main_screen(stored: &Map<String, Value>, output: &mut Map<String, Value>) {
    let colors = main_colors(stored.get("main_screen_theme_custom_colors"));
    output.insert(
        "main_screen_theme".into(),
        json!(main_theme(stored.get("main_screen_theme"))),
    );
    output.insert(
        "main_screen_theme_preset".into(),
        json!(main_preset(stored.get("main_screen_theme_preset"), &colors)),
    );
    output.insert("main_screen_theme_custom_colors".into(), json!(colors));
    let setting = wallpaper::view(stored.get(wallpaper::KEY), legacy_source(stored));
    output.insert(wallpaper::KEY.into(), setting);
}

/// The wallpaper source the legacy main-screen keys of `settings` describe.
pub(super) fn legacy_source(settings: &Map<String, Value>) -> Value {
    let colors = main_colors(settings.get("main_screen_theme_custom_colors"));
    wallpaper::from_legacy(
        main_theme(settings.get("main_screen_theme")),
        main_preset(settings.get("main_screen_theme_preset"), &colors),
        &colors,
    )
}

fn stored_settings(
    db: &Connection,
    facts: &AppSettingsFacts,
    controls: &super::controls::GlobalSettings,
) -> Result<Map<String, Value>, AppStorageError> {
    let mut stored = read_json(db, SETTINGS_KEY)?
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    super::worker_profiles::canonicalize(&mut stored, facts, &controls.model, &controls.reasoning);
    Ok(stored)
}

fn project_native_preferences(native: &Map<String, Value>, output: &mut Map<String, Value>) {
    if let Some(mode) = native.get("bridge_mode") {
        output.insert("bridge_mode".into(), mode.clone());
    }
    output.insert(
        "update_previews".into(),
        json!(
            native
                .get("update_previews")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        ),
    );
}

fn recall_defaults(stored: &serde_json::Map<String, Value>) -> serde_json::Map<String, Value> {
    let mut output = ui_defaults().as_object().cloned().unwrap_or_default();
    output.insert(
        "recall_mode".into(),
        json!(enum_value(
            stored.get("recall_mode"),
            &["faster", "accurate"],
            "accurate"
        )),
    );
    output.insert(
        "recall_judge_model".into(),
        json!(
            stored
                .get("recall_judge_model")
                .and_then(Value::as_str)
                .unwrap_or("default")
        ),
    );
    output
}
