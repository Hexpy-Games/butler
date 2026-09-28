//! The global model before the user chose one (#230): the routine preset of
//! the connected provider at the preset's effort, never the provider's top
//! model at its highest effort.

use serde_json::{Map, Value};

use super::model::{self, PrimaryModel};
use crate::gateway::application::AppSettingsFacts;
use butler_turn::btcc::ReasoningEffort;

/// The default when the catalog has no routine preset to offer.
const LEGACY_DEFAULT_MODEL: &str = "openai/gpt-5.5";

/// The global model and effort: the stored choice, else the configured
/// default model, else the routine preset. A stored effort the model does
/// not offer falls back to the model's default effort.
pub(super) fn resolve(
    stored: &Map<String, Value>,
    facts: &AppSettingsFacts,
) -> (PrimaryModel, ReasoningEffort) {
    let chosen = stored
        .get("model")
        .and_then(Value::as_str)
        .or(facts.config_default_model.as_deref());
    let (preset_model, preset_effort) = routine_default(facts);
    let metadata = model::resolve_primary(chosen.unwrap_or(&preset_model), facts);
    let preset_effort =
        preset_effort.filter(|_| chosen.is_none() && metadata.model_ref == preset_model);
    let reasoning = stored
        .get("reasoning_effort")
        .and_then(Value::as_str)
        .and_then(model::parse_reasoning)
        .or(preset_effort)
        .filter(|value| metadata.reasoning_efforts.contains(value))
        .unwrap_or_else(|| metadata.default_reasoning_effort.clone());
    (metadata, reasoning)
}

/// The routine preset of the first connected provider (OpenAI before any
/// is connected) when its model is available, with the preset's effort;
/// else the first connected model, or the legacy default.
fn routine_default(facts: &AppSettingsFacts) -> (String, Option<ReasoningEffort>) {
    let registered = facts
        .registered_models
        .iter()
        .filter(|model| model.runtime_supported && model.enabled)
        .collect::<Vec<_>>();
    let provider = registered
        .first()
        .map_or("openai", |model| model.provider_id.as_str());
    let available = if registered.is_empty() {
        facts
            .known_models
            .iter()
            .filter(|model| model.runtime_supported)
            .collect()
    } else {
        registered.clone()
    };
    let preset = facts
        .routine_presets
        .iter()
        .find(|preset| preset.provider_id == provider)
        .filter(|preset| {
            available
                .iter()
                .any(|model| model.model_ref == preset.model_ref)
        });
    match (preset, registered.first()) {
        (Some(preset), _) => (
            preset.model_ref.clone(),
            Some(preset.reasoning_effort.clone()),
        ),
        (None, Some(first)) => (first.model_ref.clone(), None),
        (None, None) => (LEGACY_DEFAULT_MODEL.to_owned(), None),
    }
}
