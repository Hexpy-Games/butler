use std::collections::HashMap;

use serde_json::Map;

use crate::locale::LocaleCollation;
use crate::models::{DEFAULT_MODEL_REF, ModelCatalogError};

use super::{
    ModelCatalogSnapshotInput, ModelCatalogView, ModelProviderMetadata, ParsedModelRef,
    ParsedModelRefSource, ProviderAuthMethod, ProviderView, ReasoningEffort, StaticCatalog,
};

pub(crate) fn parse_model_ref(input: &str) -> ParsedModelRef {
    let trimmed = crate::public_text::trim_js_whitespace(input);
    let namespaced = trimmed.split_once('/').filter(|(provider, model)| {
        !provider.is_empty()
            && !provider.chars().any(js_whitespace)
            && !model.is_empty()
            && !model.starts_with(js_whitespace)
    });
    if let Some((provider, model)) = namespaced {
        return ParsedModelRef {
            input: trimmed.into(),
            canonical_ref: format!("{provider}/{model}"),
            provider_id: provider.into(),
            model_id: model.into(),
            source: ParsedModelRefSource::Namespaced,
        };
    }
    let lower = trimmed.to_ascii_lowercase();
    let provider = if looks_like_openai(&lower) {
        "openai"
    } else {
        "custom"
    };
    ParsedModelRef {
        input: trimmed.into(),
        canonical_ref: format!("{provider}/{trimmed}"),
        provider_id: provider.into(),
        model_id: trimmed.into(),
        source: ParsedModelRefSource::RawModelId,
    }
}

fn looks_like_openai(value: &str) -> bool {
    let gpt = value.strip_prefix("gpt-").is_some_and(|tail| {
        !tail.is_empty()
            && tail
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-')
    });
    let o = value.as_bytes();
    gpt || (o.len() >= 2 && o[0] == b'o' && matches!(o[1], b'1'..=b'9'))
}

pub(super) fn overwrite_by_ref<'a>(
    models: impl Iterator<Item = &'a ModelProviderMetadata>,
) -> Vec<ModelProviderMetadata> {
    let mut output = Vec::<ModelProviderMetadata>::new();
    let mut positions = HashMap::<String, usize>::new();
    for model in models {
        if let Some(index) = positions.get(&model.model_ref).copied() {
            output[index] = model.clone();
        } else {
            positions.insert(model.model_ref.clone(), output.len());
            output.push(model.clone());
        }
    }
    output
}

pub(super) fn find_model_metadata(
    model_ref: Option<&str>,
    models: &[ModelProviderMetadata],
) -> Option<ModelProviderMetadata> {
    let parsed = parse_model_ref(model_ref.unwrap_or_default());
    if parsed.input.is_empty() {
        return None;
    }
    let exact = models
        .iter()
        .filter(|model| model.model_ref == parsed.canonical_ref)
        .collect::<Vec<_>>();
    if exact.len() == 1 {
        return Some(exact[0].clone());
    }
    if !exact.is_empty() {
        return None;
    }
    let aliases = models
        .iter()
        .filter(|model| matches_alias(model, &parsed))
        .collect::<Vec<_>>();
    (aliases.len() == 1).then(|| aliases[0].clone())
}

fn matches_alias(model: &ModelProviderMetadata, parsed: &ParsedModelRef) -> bool {
    let aliases = model.aliases.as_deref().unwrap_or_default();
    aliases
        .iter()
        .any(|alias| alias == &parsed.input || alias == &parsed.canonical_ref)
        || (parsed.source == ParsedModelRefSource::Namespaced
            && model.provider_id == parsed.provider_id
            && aliases.iter().any(|alias| alias == &parsed.model_id))
}

pub(super) fn resolve_model_metadata(
    model_ref: Option<&str>,
    models: &[ModelProviderMetadata],
) -> ModelProviderMetadata {
    let requested = model_ref
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_MODEL_REF);
    let parsed = parse_model_ref(requested);
    find_model_metadata(Some(&parsed.input), models)
        .unwrap_or_else(|| unavailable(parsed, "missing"))
}

fn unavailable(parsed: ParsedModelRef, reason: &str) -> ModelProviderMetadata {
    ModelProviderMetadata {
        provider_id: parsed.provider_id,
        provider_label: "Unavailable model".into(),
        provider_family_id: None,
        model_id: parsed.model_id,
        model_ref: parsed.canonical_ref.clone(),
        aliases: None,
        display_name: format!("{} ({reason})", parsed.canonical_ref),
        status: "deprecated".into(),
        context_window_tokens: None,
        max_output_tokens: None,
        default_reasoning_effort: ReasoningEffort::Medium,
        reasoning_efforts: vec![
            ReasoningEffort::None,
            ReasoningEffort::Low,
            ReasoningEffort::Medium,
            ReasoningEffort::High,
            ReasoningEffort::Xhigh,
            ReasoningEffort::Max,
        ],
        reasoning_budget_tokens: None,
        token_estimator: super::TokenEstimatorKind::CharacterEstimate,
        source_url: "about:blank".into(),
        runtime_supported: false,
        hosted_api_shape: None,
        api_base_url: None,
        api_type: None,
        platform: None,
        server_url: None,
        source: None,
        local_reasoning_budget_ratio: None,
        registered: None,
        enabled: None,
        auth_type: None,
        credential_id: None,
        credential_label: None,
        credential_masked_value: None,
        image_input_support: None,
        image_capability_source: None,
        image_route_health: None,
        image_input_modalities: None,
        image_accepted_mime_types: None,
        image_max_inline_bytes: None,
        image_max_width: None,
        image_max_height: None,
        image_max_pixels: None,
        image_capability_source_url: None,
        image_capability_verified_at: None,
        image_capability_revision: None,
        image_capability_digest: None,
        image_endpoint_profile_id: None,
        image_carrier_protocol: None,
        image_tool_server_id: None,
        image_tool_name: None,
        image_tool_capability_digest: None,
        extensions: Map::new(),
    }
}

pub(super) fn build_view(
    static_data: &StaticCatalog,
    input: &ModelCatalogSnapshotInput,
    collation: &LocaleCollation,
) -> Result<ModelCatalogView, ModelCatalogError> {
    let models = static_data
        .models
        .iter()
        .chain(input.extra_models.iter())
        .cloned()
        .collect::<Vec<_>>();
    let lookup = overwrite_by_ref(
        static_data
            .models
            .iter()
            .chain(input.configured_local.iter())
            .chain(input.extra_models.iter()),
    );
    let default = resolve_model_metadata(input.default_model_ref.as_deref(), &lookup);
    let registered = input
        .registered_models
        .iter()
        .cloned()
        .map(|mut model| {
            model.registered = Some(true);
            model
        })
        .collect::<Vec<_>>();
    let generation_models = if input.registered_models.is_empty() {
        &models
    } else {
        &input.registered_models
    };
    Ok(ModelCatalogView {
        generation: super::generation::generation(generation_models, collation)?,
        generated_at: input.generated_at.clone(),
        default_model_ref: default.model_ref,
        default_reasoning_effort: default.default_reasoning_effort,
        providers: provider_views(&models),
        models,
        registered_models: registered,
        provider_credentials: input.credential_views.clone(),
        worker_model_presets: static_data.presets.clone(),
    })
}

fn provider_views(models: &[ModelProviderMetadata]) -> Vec<ProviderView> {
    let mut ids = Vec::<String>::new();
    for model in models {
        if !ids.contains(&model.provider_id) {
            ids.push(model.provider_id.clone());
        }
    }
    ids.into_iter()
        .filter_map(|provider_id| {
            let provider_models = models
                .iter()
                .filter(|model| model.provider_id == provider_id)
                .cloned()
                .collect::<Vec<_>>();
            let latest = provider_models
                .iter()
                .find(|model| model.status == "latest")
                .or(provider_models.first())?;
            Some(ProviderView {
                provider_id: provider_id.clone(),
                provider_label: latest.provider_label.clone(),
                latest_model_ref: latest.model_ref.clone(),
                auth_methods: provider_auth_methods(&provider_id),
                default_api_base_url: default_hosted_provider_api_base_url(&provider_id)
                    .map(str::to_owned),
                models: provider_models,
            })
        })
        .collect()
}

pub(crate) fn provider_auth_methods(provider_id: &str) -> Vec<ProviderAuthMethod> {
    match provider_id {
        "openai" => vec![ProviderAuthMethod::ApiKey, ProviderAuthMethod::CodexOauth],
        "local" => Vec::new(),
        _ => vec![ProviderAuthMethod::ApiKey],
    }
}

pub(crate) fn default_hosted_provider_api_base_url(provider_id: &str) -> Option<&'static str> {
    match provider_id {
        "xai" => Some("https://api.x.ai/v1"),
        "qwen" => Some("https://dashscope-intl.aliyuncs.com/compatible-mode/v1"),
        "kimi" => Some("https://api.moonshot.ai/v1"),
        "zai" => Some("https://api.z.ai/api/coding/paas/v4"),
        "zai-api" => Some("https://api.z.ai/api/paas/v4"),
        "opencode-go" => Some("https://opencode.ai/zen/go/v1"),
        _ => None,
    }
}

#[cfg(test)]
pub(crate) fn model_provider_family_id(model: &ModelProviderMetadata) -> &str {
    model
        .provider_family_id
        .as_deref()
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
        .unwrap_or(&model.provider_id)
}
#[cfg(test)]
pub(crate) fn model_identity_key(model: &ModelProviderMetadata) -> String {
    format!("{}:{}", model_provider_family_id(model), model.model_id)
}

fn js_whitespace(ch: char) -> bool {
    matches!(ch, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' |
        '\u{3000}' | '\u{feff}')
}
