use butler_models::models::{ReasoningEffort, parse_model_ref};
use serde_json::Value;

use crate::web_access::service::WebAccess;

/// Planning has its own override; webSearch.model configures the search provider.
pub(super) async fn resolve(
    access: &WebAccess,
    config: &Value,
) -> (Option<String>, ReasoningEffort) {
    let explicit = config["webSearch"]["planning"]["model"]
        .as_str()
        .map(str::trim)
        .filter(|model| !model.is_empty());
    let requested_effort = serde_json::from_value::<ReasoningEffort>(
        config["webSearch"]["planning"]["reasoningEffort"].clone(),
    )
    .ok();
    let Some(configuration) = access.configuration() else {
        return (
            explicit.map(str::to_owned),
            requested_effort.unwrap_or(ReasoningEffort::Low),
        );
    };
    let Ok(read) = configuration.read().await else {
        return (
            explicit.map(str::to_owned),
            requested_effort.unwrap_or(ReasoningEffort::Low),
        );
    };
    let default = &read.catalog.view().default_model_ref;
    let provider = parse_model_ref(default).provider_id;
    let preset = read.catalog.search_planning_preset(&provider);
    let selected = explicit
        .map(str::to_owned)
        .or_else(|| preset.map(|preset| preset.model));
    // Local/custom models and hosted registrations retain their own connection.
    let selected = selected.filter(|model| {
        provider == "openai"
            || explicit.is_some()
            || read
                .registered
                .iter()
                .any(|entry| &entry.model_ref == model)
    });
    let model = selected.unwrap_or_else(|| default.clone());
    let metadata = read.catalog.find_model_metadata(Some(&model));
    let effort = metadata.map_or(ReasoningEffort::Low, |metadata| {
        if metadata.reasoning_efforts.contains(&ReasoningEffort::Low) {
            ReasoningEffort::Low
        } else {
            metadata.default_reasoning_effort
        }
    });
    (Some(model), requested_effort.unwrap_or(effort))
}
