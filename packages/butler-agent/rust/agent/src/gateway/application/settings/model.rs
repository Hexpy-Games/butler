use super::Controls;
use crate::public_text::trim_js_whitespace;
use crate::{
    btcc::{ModelFallback, ReasoningEffort},
    gateway::application::{AppModelMetadata, AppSettingsFacts, storage::AppStorageError},
};

pub(super) fn normalize(mut input: Controls, models: &[AppModelMetadata]) -> Controls {
    let metadata = resolve_runtime(&input.model, models).or_else(|| models.first());
    if let Some(metadata) = metadata {
        input.model = metadata.model_ref.clone();
        if !metadata.reasoning_efforts.contains(&input.reasoning) {
            input.reasoning = metadata.default_reasoning_effort.clone();
        }
    }
    input
}

pub(super) fn normalized_fallback(facts: &AppSettingsFacts, primary_ref: &str) -> ModelFallback {
    let primary = find_unique(primary_ref, &facts.known_models);
    let mut identities = Vec::<String>::new();
    if let Some(model) = primary {
        identities.push(identity(model));
    }
    let mut models = Vec::new();
    for requested in facts.config_model_fallback.models.iter() {
        let Some(model) = find_unique(requested, &facts.registered_models) else {
            continue;
        };
        if !model.runtime_supported || !model.registered || !model.enabled {
            continue;
        }
        let key = identity(model);
        if identities.contains(&key) {
            continue;
        }
        identities.push(key);
        models.push(model.model_ref.clone());
        if models.len() == 5 {
            break;
        }
    }
    ModelFallback {
        enabled: facts.config_model_fallback.enabled,
        models,
    }
}

pub(super) struct PrimaryModel {
    pub model_ref: String,
    pub reasoning_efforts: Vec<ReasoningEffort>,
    pub default_reasoning_effort: ReasoningEffort,
}

pub(super) fn resolve_primary(requested: &str, facts: &AppSettingsFacts) -> PrimaryModel {
    let registered = facts
        .registered_models
        .iter()
        .filter(|value| value.runtime_supported)
        .collect::<Vec<_>>();
    if !registered.is_empty() {
        if trim_js_whitespace(requested).is_empty() {
            return owned(registered[0]);
        }
        if let Some(model) = find_unique_refs(requested, &registered) {
            return owned(model);
        }
    }
    resolve_runtime(requested, &facts.known_models)
        .map(owned)
        .unwrap_or_else(|| PrimaryModel {
            model_ref: canonical_ref(requested),
            reasoning_efforts: vec![
                ReasoningEffort::None,
                ReasoningEffort::Low,
                ReasoningEffort::Medium,
                ReasoningEffort::High,
                ReasoningEffort::Xhigh,
                ReasoningEffort::Max,
            ],
            default_reasoning_effort: ReasoningEffort::Medium,
        })
}

fn owned(value: &AppModelMetadata) -> PrimaryModel {
    PrimaryModel {
        model_ref: value.model_ref.clone(),
        reasoning_efforts: value.reasoning_efforts.to_vec(),
        default_reasoning_effort: value.default_reasoning_effort.clone(),
    }
}

fn canonical_ref(value: &str) -> String {
    let trimmed = trim_js_whitespace(value);
    if trimmed.split_once('/').is_some_and(|(provider, model)| {
        !provider.is_empty()
            && !provider.chars().any(char::is_whitespace)
            && model.chars().next().is_some_and(|ch| !ch.is_whitespace())
    }) {
        return trimmed.into();
    }
    let lower = trimmed.to_ascii_lowercase();
    let openai = lower.starts_with("gpt-")
        || lower
            .strip_prefix('o')
            .and_then(|tail| tail.as_bytes().first())
            .is_some_and(|digit| (b'1'..=b'9').contains(digit));
    format!("{}/{trimmed}", if openai { "openai" } else { "custom" })
}

pub(super) fn available(facts: &AppSettingsFacts) -> &[AppModelMetadata] {
    if facts.registered_models.is_empty() {
        &facts.known_models
    } else {
        &facts.registered_models
    }
}

pub(super) fn assert_selectable(
    model: &str,
    models: &[AppModelMetadata],
) -> Result<(), AppStorageError> {
    selectable(model, models).map(|_| ()).ok_or_else(|| {
        AppStorageError::new(
            "session_model_unavailable",
            format!("The selected model is no longer available: {model}"),
        )
    })
}

pub(super) fn selectable<'a>(
    model: &str,
    models: &'a [AppModelMetadata],
) -> Option<&'a AppModelMetadata> {
    let value = trim_js_whitespace(model);
    models
        .iter()
        .find(|item| item.runtime_supported && (item.model_ref == value || item.model_id == value))
}

fn resolve_runtime<'a>(
    model: &str,
    models: &'a [AppModelMetadata],
) -> Option<&'a AppModelMetadata> {
    find_unique(model, models).filter(|value| value.runtime_supported)
}

pub(super) fn find_unique<'a>(
    model: &str,
    models: &'a [AppModelMetadata],
) -> Option<&'a AppModelMetadata> {
    let refs = models.iter().collect::<Vec<_>>();
    find_unique_refs(model, &refs)
}

fn find_unique_refs<'a>(
    model: &str,
    models: &[&'a AppModelMetadata],
) -> Option<&'a AppModelMetadata> {
    let value = trim_js_whitespace(model);
    let canonical = canonical_ref(value);
    let exact = models
        .iter()
        .copied()
        .filter(|item| item.model_ref == canonical)
        .collect::<Vec<_>>();
    if exact.len() == 1 {
        return exact.into_iter().next();
    }
    let aliases = models
        .iter()
        .copied()
        .filter(|item| {
            item.aliases
                .iter()
                .any(|alias| alias == value || alias == &canonical)
                || value.split_once('/').is_some_and(|(provider, model_id)| {
                    item.provider_id == provider
                        && item.aliases.iter().any(|alias| alias == model_id)
                })
        })
        .collect::<Vec<_>>();
    (aliases.len() == 1).then(|| aliases[0])
}

fn identity(model: &AppModelMetadata) -> String {
    format!(
        "{}:{}",
        model
            .provider_family_id
            .as_deref()
            .unwrap_or(&model.provider_id),
        model.model_id
    )
}

pub(super) fn parse_reasoning(value: &str) -> Option<ReasoningEffort> {
    match value {
        "none" => Some(ReasoningEffort::None),
        "low" => Some(ReasoningEffort::Low),
        "medium" => Some(ReasoningEffort::Medium),
        "high" => Some(ReasoningEffort::High),
        "xhigh" => Some(ReasoningEffort::Xhigh),
        "max" => Some(ReasoningEffort::Max),
        _ => None,
    }
}
