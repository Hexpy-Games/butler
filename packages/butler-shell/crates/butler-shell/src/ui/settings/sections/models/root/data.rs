//! What the Models page reads from the settings and the model catalog, and its pure helpers
//! (`backupModelsUtils.ts`, `settingsUtils.ts`).
use std::rc::Rc;

use butler_ds::ui::context::Lang;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::ui::composer::menus::{ModelChoice, model_display_name, token_window_label};
use crate::ui::i18n::composer::menus::copy as composer_copy;
use crate::ui::settings::controls::{SettingsOption, provider_mark};
use crate::ui::source::wire::ReasoningEffort;

/// `MAX_BACKUP_MODELS`
pub(crate) const MAX_BACKUP_MODELS: usize = 5;

/// `SettingsView["model_fallback"]`
#[derive(Clone, Default, Deserialize)]
pub(crate) struct Fallback {
    #[serde(default)]
    pub(crate) enabled: bool,
    #[serde(default)]
    pub(crate) models: Vec<String>,
}

/// The settings the root page reads.
#[derive(Deserialize)]
pub(crate) struct Slice {
    #[serde(default)]
    pub(crate) model: String,
    pub(crate) reasoning_effort: Option<ReasoningEffort>,
    #[serde(default)]
    pub(crate) context_window_tokens: f64,
    #[serde(default)]
    pub(crate) model_fallback: Fallback,
}

/// A registered model of the catalog (`AppModelSummary`), with the fields the backup models read.
#[derive(Clone, Deserialize)]
pub(crate) struct RegisteredModel {
    pub(crate) provider_id: String,
    #[serde(default)]
    pub(crate) provider_family_id: Option<String>,
    #[serde(default)]
    pub(crate) provider_label: String,
    pub(crate) model_id: String,
    pub(crate) model_ref: String,
    pub(crate) display_name: Option<String>,
    pub(crate) context_window_tokens: Option<f64>,
    pub(crate) platform: Option<String>,
    registered: Option<bool>,
    enabled: Option<bool>,
    #[serde(default)]
    runtime_supported: bool,
}

impl RegisteredModel {
    /// `modelDisplayName`
    pub(crate) fn name(&self) -> &str {
        self.display_name.as_deref().unwrap_or(&self.model_id)
    }

    /// `modelIdentityKey`
    fn identity(&self) -> String {
        let family = self
            .provider_family_id
            .as_deref()
            .map(str::trim)
            .filter(|family| !family.is_empty())
            .unwrap_or(&self.provider_id);
        format!("{family}:{}", self.model_id)
    }
}

/// `registered_models` of the catalog that are registered and runnable.
pub(crate) fn registered(catalog: Option<&Value>) -> Vec<RegisteredModel> {
    let models = catalog
        .and_then(|catalog| catalog.get("registered_models"))
        .and_then(Value::as_array);
    models
        .into_iter()
        .flatten()
        .filter_map(|model| serde_json::from_value::<RegisteredModel>(model.clone()).ok())
        .filter(|model| model.registered == Some(true) && model.runtime_supported)
        .collect()
}

/// `selectableBackupModels`
pub(crate) fn selectable<'a>(
    models: &'a [RegisteredModel],
    primary_ref: &str,
    selected: &[String],
) -> Vec<&'a RegisteredModel> {
    let primary = models
        .iter()
        .find(|model| model.model_ref == primary_ref)
        .map(RegisteredModel::identity);
    let taken: Vec<String> = models
        .iter()
        .filter(|model| selected.contains(&model.model_ref))
        .map(RegisteredModel::identity)
        .collect();
    models
        .iter()
        .filter(|model| {
            let identity = model.identity();
            model.enabled != Some(false)
                && model.model_ref != primary_ref
                && !selected.contains(&model.model_ref)
                && Some(&identity) != primary.as_ref()
                && !taken.contains(&identity)
        })
        .collect()
}

/// `addBackupModel`: `None` when the model is already there or the list is full.
pub(crate) fn add_backup(fallback: &Fallback, model_ref: &str) -> Option<Fallback> {
    let full = fallback.models.len() >= MAX_BACKUP_MODELS;
    if full || fallback.models.iter().any(|item| item == model_ref) {
        return None;
    }
    let mut models = fallback.models.clone();
    models.push(model_ref.to_owned());
    Some(Fallback {
        enabled: fallback.enabled,
        models,
    })
}

/// The `model_fallback` patch.
pub(crate) fn fallback_patch(enabled: bool, models: &[String]) -> Value {
    json!({ "model_fallback": { "enabled": enabled, "models": models } })
}

/// A whole, non-negative number for a JSON patch (the agent reads integers).
pub(crate) fn whole(value: f64) -> u64 {
    format!("{:.0}", value.max(0.)).parse().unwrap_or_default()
}

/// `value.toLocaleString("en-US")` of a whole number.
pub(crate) fn grouped(value: u64) -> String {
    let digits = value.to_string();
    let mut out = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// `ratioToPercent`
pub(crate) fn ratio_to_percent(ratio: Option<f64>) -> f64 {
    ratio
        .filter(|ratio| ratio.is_finite() && *ratio > 0.)
        .map_or(0., |ratio| (ratio.min(1.) * 100.).round())
}

/// `percentToRatio` of a committed percentage.
pub(crate) fn percent_to_ratio(percent: f64) -> f64 {
    percent.clamp(0., 100.).round() / 100.
}

/// The catalog entry of a model, raw (registered models first).
pub(crate) fn raw_model<'a>(catalog: Option<&'a Value>, model_ref: &str) -> Option<&'a Value> {
    let catalog = catalog?;
    ["registered_models", "models"].iter().find_map(|key| {
        catalog
            .get(key)?
            .as_array()?
            .iter()
            .find(|model| model.get("model_ref").and_then(Value::as_str) == Some(model_ref))
    })
}

/// `localModelMutationPayload`
pub(crate) fn local_model_payload(model: &Value, ratio: f64) -> Value {
    let text = |key: &str, fallback: &str| {
        model
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or(fallback)
            .to_owned()
    };
    let mut body = json!({
        "provider_id": "local",
        "api_type": text("api_type", "openai_compatible"),
        "platform": text("platform", "custom"),
        "server_url": text("server_url", ""),
        "model_id": text("model_id", ""),
        "reasoning_budget_ratio": ratio,
        "source": text("source", "manual"),
    });
    for key in ["display_name", "context_window_tokens", "max_output_tokens"] {
        if let Some(value) = model.get(key).filter(|value| !value.is_null()) {
            body[key] = value.clone();
        }
    }
    body
}

/// The model options of the pickers: "provider / name (window)" with the provider's mark.
pub(crate) fn model_options(models: &[ModelChoice], lang: Lang) -> Vec<SettingsOption> {
    models
        .iter()
        .map(|model| {
            let window = token_window_label(model.context_window_tokens, composer_copy(lang));
            let label = format!(
                "{} / {} ({window})",
                model.provider_label,
                model_display_name(model)
            );
            let (provider, platform) = (model.provider_id.clone(), model.platform.clone());
            let mut option = SettingsOption::new(model.model_ref.clone(), label);
            option.icon = Some(Rc::new(move || {
                provider_mark(&provider, platform.as_deref(), false)
            }));
            option
        })
        .collect()
}
