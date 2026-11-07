//! The `/model-catalog` and `/settings` JSON the composer reads (`ModelCatalogView`,
//! `AppModelSummary`, `SettingsView`), and the model mapping the context donut reads.
use std::collections::HashMap;

use serde::Deserialize;
use serde_json::Value;

use super::context::UsageModel;
use super::menus::ModelChoice;
use super::state::{ComposerSettings, ModelCatalog};
use crate::ui::source::wire::{AccessMode, ReasoningEffort};

#[derive(Deserialize)]
struct ModelWire {
    provider_id: String,
    #[serde(default)]
    provider_label: String,
    model_id: String,
    model_ref: String,
    display_name: Option<String>,
    context_window_tokens: Option<f64>,
    default_reasoning_effort: Option<ReasoningEffort>,
    #[serde(default)]
    reasoning_efforts: Vec<ReasoningEffort>,
    reasoning_budget_tokens: Option<HashMap<String, f64>>,
    local_reasoning_budget_ratio: Option<f64>,
    #[serde(default)]
    runtime_supported: bool,
    availability: Option<String>,
    platform: Option<String>,
    auth_type: Option<String>,
    image_input_support: Option<String>,
    image_accepted_mime_types: Option<Vec<String>>,
    image_max_inline_bytes: Option<i64>,
}

impl From<ModelWire> for ModelChoice {
    fn from(model: ModelWire) -> Self {
        let budgets = model
            .reasoning_budget_tokens
            .into_iter()
            .flatten()
            .filter_map(|(effort, tokens)| {
                let effort = serde_json::from_value(Value::String(effort)).ok()?;
                Some((effort, tokens))
            })
            .collect();
        Self {
            provider_label: if model.provider_label.is_empty() {
                model.provider_id.clone().into()
            } else {
                model.provider_label.into()
            },
            provider_id: model.provider_id.into(),
            model_id: model.model_id.into(),
            model_ref: model.model_ref.into(),
            display_name: model.display_name.map(Into::into),
            context_window_tokens: model.context_window_tokens,
            default_reasoning_effort: model.default_reasoning_effort,
            reasoning_efforts: model.reasoning_efforts,
            reasoning_budget_tokens: budgets,
            local_reasoning_budget_ratio: model.local_reasoning_budget_ratio,
            availability: model.availability.map(Into::into),
            runtime_supported: model.runtime_supported,
            platform: model.platform.map(Into::into),
            auth_type: model.auth_type.map(Into::into),
            image_input_support: model.image_input_support.map(Into::into),
            image_accepted_mime_types: model.image_accepted_mime_types,
            image_max_inline_bytes: model.image_max_inline_bytes,
        }
    }
}

#[derive(Deserialize)]
struct CatalogWire {
    #[serde(default)]
    generation: String,
    #[serde(default)]
    default_model_ref: String,
    #[serde(default)]
    models: Vec<ModelWire>,
    registered_models: Option<Vec<ModelWire>>,
}

/// The catalog of a `/model-catalog` response; `None` when it is not a catalog.
pub(super) fn decode_catalog(value: &Value) -> Option<ModelCatalog> {
    let wire = CatalogWire::deserialize(value).ok()?;
    Some(ModelCatalog {
        generation: wire.generation,
        default_model_ref: wire.default_model_ref,
        registered_models: wire
            .registered_models
            .map(|models| models.into_iter().map(Into::into).collect()),
        models: wire.models.into_iter().map(Into::into).collect(),
    })
}

#[derive(Deserialize)]
struct SettingsWire {
    #[serde(default)]
    model: String,
    reasoning_effort: Option<ReasoningEffort>,
    access_mode: Option<AccessMode>,
    #[serde(default)]
    plan_mode_default: bool,
}

/// The composer's defaults of a `/settings` response; `None` when it is not settings.
pub(super) fn decode_settings(value: &Value) -> Option<ComposerSettings> {
    let wire = SettingsWire::deserialize(value).ok()?;
    Some(ComposerSettings {
        model: wire.model,
        reasoning_effort: wire.reasoning_effort.unwrap_or(ReasoningEffort::Medium),
        access_mode: wire.access_mode.unwrap_or(AccessMode::AskExceptReads),
        plan_mode_default: wire.plan_mode_default,
    })
}

/// The fields of a model the context donut's billing mode reads.
pub(super) fn usage_model(model: &ModelChoice) -> UsageModel {
    UsageModel {
        model_ref: model.model_ref.to_string(),
        provider_id: model.provider_id.to_string(),
        platform: model.platform.as_ref().map(ToString::to_string),
        auth_type: model.auth_type.as_ref().map(ToString::to_string),
    }
}
