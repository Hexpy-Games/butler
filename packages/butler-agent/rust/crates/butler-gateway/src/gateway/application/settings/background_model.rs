use super::{AppSettingsFacts, model};
use serde_json::{Map, Value, json};

pub(super) fn project(output: &mut Map<String, Value>, facts: &AppSettingsFacts) {
    let configured = output.get("background_model").cloned().unwrap_or_else(|| {
        facts
            .native_settings
            .get("background_model")
            .cloned()
            .unwrap_or(Value::Null)
    });
    let fallback = output.get("model").and_then(Value::as_str);
    let effective = butler_core::configuration::resolve_background_model(
        None,
        configured.as_str(),
        fallback,
        |value| selectable_background_model_ref(facts, value).is_some(),
    )
    .map(str::to_owned);
    let explicit = output.get("consolidation_model").and_then(Value::as_str);
    let consolidation = butler_core::configuration::resolve_background_model(
        explicit,
        configured.as_str(),
        fallback,
        |value| selectable_background_model_ref(facts, value).is_some(),
    )
    .map(str::to_owned);
    output.insert("background_model".into(), configured);
    output.insert("effective_background_model".into(), json!(effective));
    output.insert("effective_consolidation_model".into(), json!(consolidation));
}

// API clients can submit an entire profile, including its inherited marker.
// Changing its model is an explicit selection even if that marker was copied.
pub(super) fn mark_worker_choices(output: &mut Map<String, Value>, current: &Value) {
    let Some(profiles) = output
        .get_mut("worker_profiles")
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    for profile in profiles {
        let previous = current
            .get("worker_profiles")
            .and_then(Value::as_array)
            .and_then(|values| {
                values
                    .iter()
                    .find(|value| value.get("id") == profile.get("id"))
            });
        if previous.is_some_and(|previous| previous.get("model") != profile.get("model")) {
            profile["model_explicit"] = json!(true);
        }
    }
}

/// The background choice follows the current selectable catalog and enabled state.
pub(in crate::gateway::application) fn selectable_background_model_ref(
    facts: &AppSettingsFacts,
    requested: &str,
) -> Option<String> {
    model::selectable(requested, &model::available(facts))
        .filter(|model| model.enabled)
        .map(|model| model.model_ref.clone())
}
