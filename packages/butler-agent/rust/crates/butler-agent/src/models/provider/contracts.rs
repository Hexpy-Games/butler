use std::{future::Future, pin::Pin, sync::Arc, time::Duration};

use tokio_util::sync::CancellationToken;
use url::Url;

use crate::btcc::ProviderRequestError;

use super::super::{HostedApiShape, ModelProviderMetadata, ReasoningEffort};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProviderAuthMode {
    None,
    ApiKey,
    CodexSubscription,
    CodexOauth,
}

/// Request-local credential lease. It is neither serializable nor debuggable.
pub(crate) enum ProviderAuth {
    None,
    ApiKey(String),
    Codex {
        mode: ProviderAuthMode,
        authorization: String,
        account_id: String,
        user_agent: String,
        originator: String,
    },
}

impl ProviderAuth {
    pub(crate) fn mode(&self) -> ProviderAuthMode {
        match self {
            Self::None => ProviderAuthMode::None,
            Self::ApiKey(_) => ProviderAuthMode::ApiKey,
            Self::Codex { mode, .. } => *mode,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct ProviderRoundPolicy {
    pub total: Duration,
    pub idle: Option<Duration>,
    pub retry_base_ms: f64,
}

pub(crate) struct ProviderConfigRequest<'a> {
    pub model_ref: &'a str,
    pub butler_data: Option<&'a str>,
}

/// One coherent, owned physical-request snapshot.
pub(crate) struct ProviderRequestConfig {
    pub metadata: ModelProviderMetadata,
    pub wire_model: String,
    pub endpoint: Url,
    pub api_shape: Option<HostedApiShape>,
    pub auth: ProviderAuth,
    pub policy: ProviderRoundPolicy,
    pub retry_attempts: f64,
    pub prompt_cache: ProviderPromptCachePolicy,
    /// OpenAI's request-local configured fallback; explicit request effort wins.
    pub prompt_reasoning_effort: Option<ReasoningEffort>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PromptCacheRetention {
    InMemory,
    Hours24,
}

#[derive(Default)]
pub(crate) struct ProviderPromptCachePolicy {
    pub key_prefix: Option<String>,
    pub retention: Option<PromptCacheRetention>,
}

pub(crate) type ProviderConfigFuture<'a> = Pin<
    Box<dyn Future<Output = Result<ProviderRequestConfig, Box<ProviderRequestError>>> + Send + 'a>,
>;

pub(crate) trait ProviderRequestConfigPort: Send + Sync {
    /// Source prompt routing reads the process-default config synchronously
    /// before invocation intent and before physical auth/config resolution.
    fn effective_prompt_model(
        &self,
        requested: Option<&str>,
    ) -> Result<String, crate::btcc::ModelRoundError>;

    fn resolve<'a>(&'a self, request: ProviderConfigRequest<'a>) -> ProviderConfigFuture<'a>;

    /// Source sizing is synchronous and rereads the selected Butler data root.
    /// The returned snapshot is held only by the resulting measure closure.
    fn sizing_snapshot(
        &self,
        butler_data: Option<&str>,
    ) -> Result<Arc<super::super::ModelCatalogSnapshot>, crate::btcc::ModelRoundError>;
}

pub(crate) type ProviderVisualCapabilityFuture<'a> =
    Pin<Box<dyn Future<Output = Result<String, ()>> + Send + 'a>>;

/// Host-owned live capability facts needed to revalidate an admitted visual
/// route immediately before a physical provider request.
pub(crate) trait ProviderVisualCapabilityPort: Send + Sync {
    fn zai_vision_tool_capability_digest<'a>(
        &'a self,
        metadata: &'a ModelProviderMetadata,
        cancellation: &'a CancellationToken,
    ) -> ProviderVisualCapabilityFuture<'a>;
}

pub(crate) trait ProviderClock: Send + Sync {
    fn now_epoch_millis(&self) -> i64;
}

pub(crate) struct ProviderObservation {
    pub request_bytes: usize,
}

pub(crate) trait ProviderObservationSink: Send + Sync {
    fn request(&self, observation: ProviderObservation);
    fn response(&self, provider: &str, model_ref: &str);
    fn failure(&self, error: &ProviderRequestError);
}
