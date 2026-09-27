use std::path::Path;

use serde_json::{Value, json};

use super::super::super::{AppSettingsFacts, model};
use crate::{btcc::ReasoningEffort, gateway::application::settings::worker_profiles};

pub(super) fn project(
    current: &Value,
    patch: &Value,
    facts: &AppSettingsFacts,
    workspace_root: &Path,
) -> Value {
    let mut output = current.as_object().cloned().unwrap_or_default();
    let patch = patch.as_object().cloned().unwrap_or_default();
    for key in [
        "server_url",
        "language",
        "timezone",
        "access_mode",
        "plan_mode_default",
        "follow_up_behavior",
        "multiline_send_behavior",
        "appearance_theme",
        "main_screen_theme",
        "main_screen_theme_preset",
        "main_screen_theme_custom_colors",
        "translucent_sidebar",
        "smart_grouping_enabled",
        "diagnostics_enabled",
        "desktop_tray_enabled",
        "max_simultaneous_workers",
    ] {
        if let Some(value) = patch.get(key) {
            output.insert(key.into(), value.clone());
        }
    }
    let previous_model = current
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("openai/gpt-5.5");
    let requested_model = patch
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or(previous_model);
    let resolved = model::resolve_primary(requested_model, facts);
    let (efforts, default_effort) = super::super::reasonings_for(&resolved.model_ref, facts);
    let requested_reasoning = patch
        .get("reasoning_effort")
        .or_else(|| current.get("reasoning_effort"))
        .and_then(Value::as_str)
        .and_then(reasoning)
        .unwrap_or_else(|| default_effort.clone());
    let selected_reasoning = if efforts.contains(&requested_reasoning) {
        requested_reasoning
    } else {
        default_effort
    };
    output.insert("model".into(), json!(resolved.model_ref));
    output.insert("reasoning_effort".into(), json!(selected_reasoning));

    let current_context = current
        .get("context_window_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(258_000);
    let old_max = model_max(previous_model, facts);
    let new_max = model_max(&resolved.model_ref, facts);
    let requested_context = patch
        .get("context_window_tokens")
        .and_then(Value::as_u64)
        .unwrap_or_else(|| {
            if patch.contains_key("model") && current_context >= old_max {
                new_max
            } else {
                current_context
            }
        });
    output.insert(
        "context_window_tokens".into(),
        json!(requested_context.min(new_max).max(1_000)),
    );

    if patch.contains_key("worker_profiles") {
        output.insert(
            "worker_profiles".into(),
            patch
                .get("worker_profiles")
                .cloned()
                .unwrap_or_else(|| json!([])),
        );
    }
    let mut stored = output.clone();
    worker_profiles::canonicalize(
        &mut stored,
        facts,
        output["model"].as_str().unwrap_or("openai/gpt-5.5"),
        output["reasoning_effort"]
            .as_str()
            .and_then(reasoning)
            .as_ref()
            .unwrap_or(&ReasoningEffort::Xhigh),
    );
    if let Some(value) = stored.get("worker_profiles") {
        output.insert("worker_profiles".into(), value.clone());
    }

    let current_fallback = current
        .get("model_fallback")
        .cloned()
        .unwrap_or(Value::Null);
    if patch.contains_key("model_fallback") || patch.contains_key("model") {
        output.insert(
            "model_fallback".into(),
            super::super::normalize_model_fallback(
                patch.get("model_fallback").unwrap_or(&Value::Null),
                &current_fallback,
                output["model"].as_str().unwrap_or(""),
                facts,
            ),
        );
    }
    if patch.contains_key("consolidation_model")
        || patch.contains_key("consolidation_reasoning_effort")
    {
        let consolidation = facts
            .native_settings
            .get("consolidation")
            .cloned()
            .unwrap_or(Value::Null);
        let configured = consolidation
            .get("model")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or("default");
        let uses_butler = consolidation
            .get("uses_butler_model")
            .and_then(Value::as_bool)
            == Some(true);
        output.insert(
            "consolidation_model".into(),
            json!(
                patch
                    .get("consolidation_model")
                    .and_then(Value::as_str)
                    .unwrap_or(configured)
            ),
        );
        output.insert(
            "consolidation_reasoning_effort".into(),
            patch
                .get("consolidation_reasoning_effort")
                .cloned()
                .unwrap_or_else(|| {
                    consolidation
                        .get("reasoning_effort")
                        .cloned()
                        .unwrap_or(json!("xhigh"))
                }),
        );
        output.insert(
            "effective_consolidation_model".into(),
            if uses_butler {
                output["model"].clone()
            } else {
                consolidation
                    .get("effective_model")
                    .cloned()
                    .unwrap_or(output["model"].clone())
            },
        );
        output.insert("consolidation_uses_butler_model".into(), json!(uses_butler));
    }
    if patch.contains_key("desktop_notifications") {
        let current = current
            .get("desktop_notifications")
            .and_then(Value::as_object);
        let update = patch
            .get("desktop_notifications")
            .and_then(Value::as_object);
        output.insert(
            "desktop_notifications".into(),
            json!({
                "enabled":update.and_then(|value| value.get("enabled")).and_then(Value::as_bool).or_else(|| current.and_then(|value| value.get("enabled")).and_then(Value::as_bool)) != Some(false),
                "assistant_messages":update.and_then(|value| value.get("assistant_messages")).and_then(Value::as_bool).or_else(|| current.and_then(|value| value.get("assistant_messages")).and_then(Value::as_bool)) != Some(false),
                "task_completions":update.and_then(|value| value.get("task_completions")).and_then(Value::as_bool).or_else(|| current.and_then(|value| value.get("task_completions")).and_then(Value::as_bool)) != Some(false)
            }),
        );
    }
    if patch.contains_key("web_search") {
        let old = current.get("web_search").and_then(Value::as_object);
        let update = patch.get("web_search").and_then(Value::as_object);
        let provider = update
            .and_then(|value| value.get("provider"))
            .and_then(Value::as_str)
            .or_else(|| {
                old.and_then(|value| value.get("provider"))
                    .and_then(Value::as_str)
            })
            .unwrap_or("duckduckgo-html");
        let credentials = facts
            .native_settings
            .get("web_search_credentials")
            .and_then(|value| value.get(provider));
        let config_var = credentials.and_then(|value| value.get("env_var")).cloned();
        let configured = credentials
            .and_then(|value| value.get("configured"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut web_search = old.cloned().unwrap_or_default();
        for (source, target) in [
            ("provider", "provider"),
            ("reader_backend", "reader_backend"),
            ("planning_enabled", "planning_enabled"),
            ("planning_default_depth", "planning_default_depth"),
        ] {
            if let Some(value) = update.and_then(|value| value.get(source)) {
                web_search.insert(target.into(), value.clone());
            }
        }
        web_search.insert("provider".into(), json!(provider));
        web_search.insert("api_key_configured".into(), json!(configured));
        web_search.insert("api_key_env_var".into(), config_var.unwrap_or(Value::Null));
        output.insert("web_search".into(), Value::Object(web_search));
    }
    output.insert(
        "default_project_workspace_label".into(),
        json!(workspace_label(workspace_root)),
    );
    Value::Object(output)
}

fn reasoning(value: &str) -> Option<ReasoningEffort> {
    model::parse_reasoning(value)
}

fn model_max(model_ref: &str, facts: &AppSettingsFacts) -> u64 {
    facts
        .known_models
        .iter()
        .chain(facts.registered_models.iter())
        .find(|model| model.model_ref == model_ref)
        .and_then(|model| model.context_window_tokens)
        .unwrap_or(258_000)
}

fn workspace_label(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("Project")
        .to_owned()
}
