mod generation;
mod local;
mod lookup;
mod registered;
mod static_data;

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::locale::LocaleCollation;

use super::{ModelCatalogError, tokenizer::TokenizerOwner};

pub(crate) use local::{
    LocalModelConfig, LocalModelPlatform, LocalModelSource, normalize_local_model_config,
};
#[cfg(test)]
pub(crate) use lookup::model_identity_key;
pub(crate) use lookup::{default_hosted_provider_api_base_url, parse_model_ref};
pub(crate) use registered::{
    ImageProbeEvidence, RegisteredHostedModelConfig, normalize_hosted_api_base_url,
    normalize_registered_hosted_model, registered_hosted_model_metadata,
};
pub(super) use registered::{hosted_provider, safe_label as normalize_display_label};
pub(super) use static_data::StaticCatalog;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ReasoningEffort {
    None,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl ReasoningEffort {
    /// The serde (`snake_case`) name.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProviderAuthMethod {
    ApiKey,
    CodexOauth,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum HostedApiShape {
    OpenaiChatCompletions,
    OpenaiResponses,
    AnthropicMessages,
    GeminiGenerateContent,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TokenEstimatorKind {
    ProviderUsage,
    OpenaiTiktokenO200k,
    AnthropicCountTokensApi,
    GeminiCountTokensApi,
    GeminiCharacterEstimate,
    CharacterEstimate,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct ModelProviderMetadata {
    pub provider_id: String,
    pub provider_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_family_id: Option<String>,
    pub model_id: String,
    pub model_ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aliases: Option<Vec<String>>,
    pub display_name: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window_tokens: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<f64>,
    pub default_reasoning_effort: ReasoningEffort,
    pub reasoning_efforts: Vec<ReasoningEffort>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_budget_tokens: Option<Map<String, Value>>,
    pub token_estimator: TokenEstimatorKind,
    pub source_url: String,
    pub runtime_supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hosted_api_shape: Option<HostedApiShape>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform: Option<LocalModelPlatform>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<LocalModelSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_reasoning_budget_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registered: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_type: Option<ProviderAuthMethod>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_masked_value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_input_support: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_capability_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_route_health: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_input_modalities: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_accepted_mime_types: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_max_inline_bytes: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_max_width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_max_height: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_max_pixels: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_capability_source_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_capability_verified_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_capability_revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_capability_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_endpoint_profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_carrier_protocol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_tool_server_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_tool_capability_digest: Option<String>,
    #[serde(flatten)]
    pub extensions: Map<String, Value>,
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct CredentialView {
    pub id: String,
    pub provider_id: String,
    pub auth_type: ProviderAuthMethod,
    pub label: String,
    pub masked_value: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct WorkerModelRule {
    pub id: String,
    pub label: String,
    pub condition: String,
    pub model: String,
    pub reasoning_effort: ReasoningEffort,
    pub enabled: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct WorkerModelPreset {
    pub provider_id: String,
    pub provider_label: String,
    pub runtime_supported: bool,
    pub source_url: String,
    pub deep_work: WorkerModelRule,
    pub routine_work: WorkerModelRule,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct ProviderView {
    pub provider_id: String,
    pub provider_label: String,
    pub latest_model_ref: String,
    pub auth_methods: Vec<ProviderAuthMethod>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_api_base_url: Option<String>,
    pub models: Vec<ModelProviderMetadata>,
}

#[derive(Clone, Serialize)]
pub(crate) struct ModelCatalogView {
    pub generation: String,
    pub generated_at: String,
    pub default_model_ref: String,
    pub default_reasoning_effort: ReasoningEffort,
    pub providers: Vec<ProviderView>,
    pub models: Vec<ModelProviderMetadata>,
    pub registered_models: Vec<ModelProviderMetadata>,
    pub provider_credentials: Vec<CredentialView>,
    pub worker_model_presets: Vec<WorkerModelPreset>,
}

pub(crate) struct ModelCatalogSnapshotInput {
    pub configured_local: Vec<ModelProviderMetadata>,
    pub extra_models: Vec<ModelProviderMetadata>,
    pub registered_models: Vec<ModelProviderMetadata>,
    pub credential_views: Vec<CredentialView>,
    pub default_model_ref: Option<String>,
    pub generated_at: String,
}

pub(crate) struct ModelCatalogSnapshot {
    static_catalog: Arc<StaticCatalog>,
    configured_local: Arc<[ModelProviderMetadata]>,
    extra_models: Arc<[ModelProviderMetadata]>,
    view: ModelCatalogView,
}

impl ModelCatalogSnapshot {
    pub(super) fn new(
        static_catalog: Arc<StaticCatalog>,
        input: ModelCatalogSnapshotInput,
        collation: &LocaleCollation,
    ) -> Result<Self, ModelCatalogError> {
        let view = lookup::build_view(&static_catalog, &input, collation)?;
        Ok(Self {
            static_catalog,
            configured_local: input.configured_local.into(),
            extra_models: input.extra_models.into(),
            view,
        })
    }
    pub(crate) fn view(&self) -> &ModelCatalogView {
        &self.view
    }
    #[cfg(test)]
    pub(crate) fn list_model_metadata(&self) -> Vec<ModelProviderMetadata> {
        self.view.models.clone()
    }
    pub(crate) fn find_model_metadata(
        &self,
        model_ref: Option<&str>,
    ) -> Option<ModelProviderMetadata> {
        lookup::find_model_metadata(model_ref, &self.view.models)
    }
    pub(crate) fn find_static_model_metadata(
        &self,
        model_ref: Option<&str>,
    ) -> Option<ModelProviderMetadata> {
        lookup::find_model_metadata(model_ref, &self.static_catalog.models)
    }
    pub(crate) fn resolve_model_metadata(&self, model_ref: Option<&str>) -> ModelProviderMetadata {
        lookup::resolve_model_metadata(model_ref, &self.lookup_models())
    }
    fn lookup_models(&self) -> Vec<ModelProviderMetadata> {
        lookup::overwrite_by_ref(
            self.static_catalog
                .models
                .iter()
                .chain(self.configured_local.iter())
                .chain(self.extra_models.iter()),
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ParsedModelRefSource {
    Namespaced,
    RawModelId,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ParsedModelRef {
    pub input: String,
    pub canonical_ref: String,
    pub provider_id: String,
    pub model_id: String,
    pub source: ParsedModelRefSource,
}

pub(crate) enum TokenEstimateInput<'a> {
    Text(&'a str),
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct TokenEstimate {
    pub tokens: f64,
    pub source: TokenEstimatorKind,
}

pub(super) fn estimate_tokens(
    snapshot: &ModelCatalogSnapshot,
    tokenizer: &TokenizerOwner,
    input: TokenEstimateInput<'_>,
    model_ref: Option<&str>,
) -> Result<TokenEstimate, ModelCatalogError> {
    let TokenEstimateInput::Text(text) = input;
    if text.is_empty() {
        return Ok(TokenEstimate {
            tokens: 0.0,
            source: TokenEstimatorKind::CharacterEstimate,
        });
    }
    let metadata = snapshot.resolve_model_metadata(model_ref);
    if metadata.provider_id == "openai" {
        return Ok(TokenEstimate {
            tokens: tokenizer.count_ordinary(text)? as f64,
            source: TokenEstimatorKind::OpenaiTiktokenO200k,
        });
    }
    let utf16 = text.encode_utf16().count() as f64;
    let (tokens, source) = if metadata.provider_id == "google" {
        (
            (utf16 / 4.0).ceil(),
            TokenEstimatorKind::GeminiCharacterEstimate,
        )
    } else {
        ((utf16 / 3.8).ceil(), TokenEstimatorKind::CharacterEstimate)
    };
    Ok(TokenEstimate { tokens, source })
}
