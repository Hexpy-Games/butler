//! Immutable model catalog snapshots and source-compatible token estimation.

mod catalog;
mod configuration;
mod diagnostics;
mod prompt;
mod provider;
mod quota;
mod request_admission;
mod request_guard;
mod status;
mod tokenizer;
mod transport;
mod visual_admission;
mod visual_manifest;

pub use visual_admission::{
    ImageCapabilityEvidence, ImageCarrierTuple, VisualImageAdmissionResult,
    admit_visual_image_request, assert_visual_carrier_matches_catalog,
    image_admission_for_catalog_entry,
};
pub use visual_manifest::VisualAttachmentManifest;

pub use transport::provider_http_client;

// Prompt clients receive the same typed error as the provider round adapter.
// Expose it with the prompt API so lifecycle callbacks need no BTCC imports.
pub use butler_turn::btcc::ModelRoundError as ProviderPromptError;

pub use prompt::{
    PromptAdapterEntry, PromptCallbackFuture, PromptInvocationIntent, PromptJsonSchema,
    PromptUsageAttribution, PromptUsageBudgetState, PromptUsageMetricInput, PromptUsageMetricSink,
    PromptUsageReport, PromptUsageSectionAttribution, ProviderPromptFuture,
    ProviderPromptLifecycle, ProviderPromptPort, ProviderPromptRequest, ProviderPromptResult,
};
pub use prompt::{PromptBudgetStateSource, PromptCacheBoundary, UsageAuthMode};
pub use quota::{
    ProviderQuotaReading, ProviderQuotaSink, ProviderQuotaSource, ProviderQuotaWindow,
    QUOTA_POLLED_PROVIDERS, QuotaBilling, QuotaFetch, QuotaFetchError, QuotaHttp, QuotaSupport,
    parse_quota_headers, provider_quota_support,
};
#[cfg(any(test, feature = "test-support"))]
pub(crate) use visual_admission::ImageAdmissionError;

pub use provider::{
    ModelProvider, PromptCacheRetention, ProviderAuth, ProviderAuthMode, ProviderClock,
    ProviderConfigFuture, ProviderConfigRequest, ProviderObservation, ProviderObservationSink,
    ProviderPromptCachePolicy, ProviderRequestConfig, ProviderRequestConfigPort,
    ProviderRoundPolicy, ProviderVisualCapabilityFuture, ProviderVisualCapabilityPort,
};

#[cfg(any(test, feature = "test-support"))]
pub(crate) use catalog::model_identity_key;
pub use catalog::{
    ApiKeyBilling, CredentialView, HostedApiShape, ImageLimitField, ImageLimitSources,
    ImageProbeEvidence, LocalModelConfig, LocalModelPlatform, LocalModelSource,
    ModelCatalogSnapshot, ModelCatalogSnapshotInput, ModelPreset, ModelPricing,
    ModelProviderMetadata, ModelTier, NextPrices, ParsedModelRef, ParsedModelRefSource,
    PromptPriceTier, ProviderAuthMethod, ProviderPresets, ReasoningEffort,
    RegisteredHostedModelConfig, RequestTokens, TokenEstimate, TokenEstimateInput,
    TokenEstimatorKind, TokenPrices, default_hosted_provider_api_base_url,
    normalize_hosted_api_base_url, normalize_local_model_config, normalize_registered_hosted_model,
    parse_model_ref, registered_hosted_model_metadata, upgrade_routine_preset,
};

use std::borrow::Cow;
use std::sync::Arc;

use butler_core::locale::LocaleCollation;
use catalog::StaticCatalog;
use tokenizer::TokenizerOwner;

pub use configuration::{
    DiscoveredLocalModel, HostedModelMutation, LocalModelMutation, McpModelTarget,
    ModelConfiguration, ModelConfigurationClock, ModelConfigurationEnvironment,
    ModelConfigurationRead, ProviderCredentialMutation, SettingsError, generate_pkce_verifier,
    pkce_challenge,
};
pub use status::{StatusModels, auth_status_with_environment, open_status_models};

pub const DEFAULT_MODEL_REF: &str = "openai/gpt-5.5";

pub const CLI_FALLBACK_OPENAI_MODELS: &[&str] = &[
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
pub struct ModelCatalog {
    static_catalog: Arc<StaticCatalog>,
    tokenizer: TokenizerOwner,
}

impl ModelCatalog {
    pub fn new() -> Result<Self, ModelCatalogError> {
        Ok(Self {
            static_catalog: Arc::new(StaticCatalog::load()?),
            tokenizer: TokenizerOwner::default(),
        })
    }

    /// The provider's static routine preset (`presets.routine`): the model
    /// and effort a new user of that provider starts with.
    pub fn routine_preset(&self, provider_id: &str) -> Option<ModelPreset> {
        self.static_catalog.routine_preset(provider_id).cloned()
    }

    /// The official list price of a static catalog model ref or declared
    /// alias, `None` when the model is not in the static catalog.
    pub fn pricing(&self, model_ref: &str) -> Option<ModelPricing> {
        self.static_catalog.pricing(model_ref)
    }

    /// How a request to `provider_id` with credential `auth` is billed:
    /// Codex logins and subscription-plan API keys (GLM Coding Plan,
    /// OpenCode Go) against plan quota, other API keys per token.
    pub fn usage_auth_mode(&self, provider_id: &str, auth: ProviderAuthMode) -> UsageAuthMode {
        if provider_id == "local" {
            return UsageAuthMode::Local;
        }
        match auth {
            ProviderAuthMode::CodexSubscription | ProviderAuthMode::CodexOauth => {
                UsageAuthMode::Subscription
            }
            ProviderAuthMode::ApiKey => match self.static_catalog.api_key_billing(provider_id) {
                ApiKeyBilling::PerToken => UsageAuthMode::ApiKey,
                ApiKeyBilling::Subscription => UsageAuthMode::Subscription,
            },
            ProviderAuthMode::None => UsageAuthMode::Unknown,
        }
    }

    pub fn snapshot(
        &self,
        input: ModelCatalogSnapshotInput,
        collation: &LocaleCollation,
    ) -> Result<ModelCatalogSnapshot, ModelCatalogError> {
        ModelCatalogSnapshot::new(Arc::clone(&self.static_catalog), input, collation)
    }

    pub fn estimate_tokens(
        &self,
        snapshot: &ModelCatalogSnapshot,
        input: TokenEstimateInput<'_>,
        model_ref: Option<&str>,
    ) -> Result<TokenEstimate, ModelCatalogError> {
        catalog::estimate_tokens(snapshot, &self.tokenizer, input, model_ref)
    }
}

/// Failures of the model catalog, model configuration and tokenizer.
///
/// `Display` is the user-facing message.
#[derive(Debug, thiserror::Error)]
pub enum ModelCatalogError {
    /// A configuration request or stored value was rejected; the message says why.
    #[error("{0}")]
    Rejected(Cow<'static, str>),
    /// Local model discovery failed; the message says which check failed.
    #[error("local_model_discovery_failed: {message}")]
    Discovery {
        message: &'static str,
        #[source]
        source: Option<Box<dyn std::error::Error + Send + Sync>>,
    },
    /// A model configuration or credentials file could not be read, encoded
    /// or written; the message says which.
    #[error("{message}")]
    Storage {
        message: &'static str,
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },
    /// The bundled or generated catalog could not be encoded or decoded.
    #[error(transparent)]
    Catalog(#[from] serde_json::Error),
    /// Canonical JSON encoding of the catalog failed.
    #[error(transparent)]
    CatalogJson(#[from] butler_core::json::JsonError),
    /// The tokenizer could not be initialized.
    #[error("{0}")]
    Tokenizer(Arc<dyn std::error::Error + Send + Sync>),
}

impl ModelCatalogError {
    pub(super) fn rejected(message: impl Into<Cow<'static, str>>) -> Self {
        Self::Rejected(message.into())
    }
}

#[cfg(test)]
mod tests;
