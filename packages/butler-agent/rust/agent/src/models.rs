//! Immutable model catalog snapshots and source-compatible token estimation.

mod catalog;
mod configuration;
mod diagnostics;
mod prompt;
mod provider;
mod request_admission;
mod request_guard;
#[cfg(unix)]
mod status;
mod tokenizer;
mod transport;
mod visual_admission;
mod visual_manifest;

pub(crate) use visual_admission::{
    ImageCapabilityEvidence, ImageCarrierTuple, VisualImageAdmissionResult,
    admit_visual_image_request, assert_visual_carrier_matches_catalog,
    image_admission_for_catalog_entry,
};
pub(crate) use visual_manifest::VisualAttachmentManifest;

pub(crate) use transport::provider_http_client;

// Prompt clients receive the same typed error as the provider round adapter.
// Expose it with the prompt API so lifecycle callbacks need no BTCC imports.
pub(crate) use crate::btcc::ModelRoundError as ProviderPromptError;

pub(crate) use prompt::{
    PromptAdapterEntry, PromptCallbackFuture, PromptInvocationIntent, PromptJsonSchema,
    PromptUsageAttribution, PromptUsageBudgetState, PromptUsageMetricInput, PromptUsageMetricSink,
    PromptUsageReport, PromptUsageSectionAttribution, ProviderPromptFuture,
    ProviderPromptLifecycle, ProviderPromptPort, ProviderPromptRequest, ProviderPromptResult,
};
#[cfg(test)]
pub(crate) use prompt::{PromptBudgetStateSource, PromptCacheBoundary};
#[cfg(test)]
pub(crate) use visual_admission::ImageAdmissionError;

pub(crate) use provider::{
    NativeModelProvider, PromptCacheRetention, ProviderAuth, ProviderAuthMode, ProviderClock,
    ProviderConfigFuture, ProviderConfigRequest, ProviderObservation, ProviderObservationSink,
    ProviderPromptCachePolicy, ProviderRequestConfig, ProviderRequestConfigPort,
    ProviderRoundPolicy, ProviderVisualCapabilityFuture, ProviderVisualCapabilityPort,
};

#[cfg(test)]
pub(crate) use catalog::model_identity_key;
pub(crate) use catalog::{
    CredentialView, HostedApiShape, ImageProbeEvidence, LocalModelConfig, LocalModelPlatform,
    LocalModelSource, ModelCatalogSnapshot, ModelCatalogSnapshotInput, ModelProviderMetadata,
    ParsedModelRef, ParsedModelRefSource, ProviderAuthMethod, ReasoningEffort,
    RegisteredHostedModelConfig, TokenEstimate, TokenEstimateInput, TokenEstimatorKind,
    default_hosted_provider_api_base_url, normalize_hosted_api_base_url,
    normalize_local_model_config, normalize_registered_hosted_model, parse_model_ref,
    registered_hosted_model_metadata,
};

use std::sync::Arc;

use crate::locale::LocaleCollation;
use catalog::StaticCatalog;
use tokenizer::TokenizerOwner;

pub(crate) use configuration::{
    DiscoveredLocalModel, HostedModelMutation, LocalModelMutation, McpModelTarget,
    ModelConfiguration, ModelConfigurationClock, ModelConfigurationEnvironment,
    ModelConfigurationRead, ProviderCredentialMutation, generate_pkce_verifier, pkce_challenge,
};
#[cfg(unix)]
pub(crate) use status::{NativeStatusModels, auth_status_with_environment, open_status_models};

pub(crate) const DEFAULT_MODEL_REF: &str = "openai/gpt-5.5";

pub(crate) const CLI_FALLBACK_OPENAI_MODELS: &[&str] = &[
    "gpt-5.5-codex",
    "gpt-6-astra",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5-codex",
    "gpt-5",
];

/// Process-owned immutable catalog data and lazily allocated tokenizer.
pub(crate) struct ModelCatalog {
    static_catalog: Arc<StaticCatalog>,
    tokenizer: TokenizerOwner,
}

impl ModelCatalog {
    pub(crate) fn new() -> Result<Self, ModelCatalogError> {
        Ok(Self {
            static_catalog: Arc::new(StaticCatalog::load()?),
            tokenizer: TokenizerOwner::default(),
        })
    }

    pub(crate) fn snapshot(
        &self,
        input: ModelCatalogSnapshotInput,
        collation: &LocaleCollation,
    ) -> Result<ModelCatalogSnapshot, ModelCatalogError> {
        ModelCatalogSnapshot::new(Arc::clone(&self.static_catalog), input, collation)
    }

    pub(crate) fn estimate_tokens(
        &self,
        snapshot: &ModelCatalogSnapshot,
        input: TokenEstimateInput<'_>,
        model_ref: Option<&str>,
    ) -> Result<TokenEstimate, ModelCatalogError> {
        catalog::estimate_tokens(snapshot, &self.tokenizer, input, model_ref)
    }
}

#[derive(Debug)]
pub(crate) struct ModelCatalogError(String);

impl ModelCatalogError {
    pub(super) fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl std::fmt::Display for ModelCatalogError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ModelCatalogError {}

#[cfg(test)]
mod tests;
