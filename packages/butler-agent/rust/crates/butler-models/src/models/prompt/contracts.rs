use std::{future::Future, pin::Pin};

use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

use butler_turn::btcc::AttachmentRef;
use butler_turn::btcc::ModelRoundError;
use butler_turn::btcc::ProviderStreamObserver;

use super::super::{PromptCacheRetention, ReasoningEffort};

pub type PromptCallbackFuture<'a> =
    Pin<Box<dyn Future<Output = Result<(), ModelRoundError>> + Send + 'a>>;
pub type ProviderPromptFuture<'a> =
    Pin<Box<dyn Future<Output = Result<ProviderPromptResult, ModelRoundError>> + Send + 'a>>;

pub trait PromptInvocationIntent: Send + Sync {
    fn invoked(&self) -> PromptCallbackFuture<'_>;
}

pub trait PromptAdapterEntry: Send + Sync {
    fn entered(&self) -> Result<(), ModelRoundError>;
}

#[derive(Clone, Copy)]
pub struct ProviderPromptLifecycle<'a> {
    pub invocation_intent: Option<&'a dyn PromptInvocationIntent>,
    pub adapter_entry: Option<&'a dyn PromptAdapterEntry>,
}

impl ProviderPromptLifecycle<'_> {
    pub const fn none() -> Self {
        Self {
            invocation_intent: None,
            adapter_entry: None,
        }
    }
}

pub struct PromptJsonSchema<'a> {
    pub name: &'a str,
    pub schema: &'a Map<String, Value>,
    pub strict: Option<bool>,
}

pub struct PromptCacheBoundary<'a> {
    pub stable_prefix: &'a str,
    pub dynamic_suffix: &'a str,
}

pub struct ProviderPromptRequest<'a> {
    pub prompt: &'a str,
    pub model: Option<&'a str>,
    pub reasoning_effort: Option<&'a ReasoningEffort>,
    pub instructions: Option<&'a str>,
    pub response_format: Option<PromptJsonSchema<'a>>,
    pub cache_scope: Option<&'a str>,
    pub cache_boundary: Option<PromptCacheBoundary<'a>>,
    pub cancellation: CancellationToken,
    pub attachments: &'a [AttachmentRef],
    pub butler_data: Option<&'a str>,
    pub usage_attribution: Option<&'a PromptUsageAttribution<'a>>,
    pub stream_observer: Option<&'a dyn ProviderStreamObserver>,
    pub provider_retry_attempts: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PromptUsageReport {
    pub model: String,
    pub prompt_tokens: Option<f64>,
    pub cached_tokens: f64,
    pub total_tokens: Option<f64>,
    pub output_tokens: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProviderPromptResult {
    pub text: String,
    pub model: String,
    pub usage: Option<PromptUsageReport>,
}

pub trait ProviderPromptPort: Send + Sync {
    fn run_prompt<'a>(
        &'a self,
        request: ProviderPromptRequest<'a>,
        lifecycle: ProviderPromptLifecycle<'a>,
    ) -> ProviderPromptFuture<'a>;
}

#[derive(Clone, Debug, PartialEq)]
pub struct PromptUsageBudgetState {
    pub status: String,
    pub request_count: f64,
    pub max_requests: f64,
    pub prompt_tokens: Option<f64>,
    pub cached_tokens: Option<f64>,
    pub output_tokens: Option<f64>,
    pub total_tokens: Option<f64>,
    pub max_prompt_tokens: Option<f64>,
    pub max_output_tokens: Option<f64>,
    pub max_total_tokens: Option<f64>,
    pub cumulative_request_count: Option<f64>,
    pub cumulative_prompt_tokens: Option<f64>,
    pub cumulative_cached_tokens: Option<f64>,
    pub cumulative_output_tokens: Option<f64>,
    pub cumulative_total_tokens: Option<f64>,
    pub stop_reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PromptUsageSectionAttribution {
    pub id: String,
    pub chars: f64,
    pub estimated_tokens: f64,
}

pub trait PromptBudgetStateSource: Send + Sync {
    fn snapshot(&self) -> Result<Option<PromptUsageBudgetState>, ModelRoundError>;
}

pub struct PromptUsageAttribution<'a> {
    pub turn_id: Option<&'a str>,
    pub phase: Option<&'a str>,
    pub round_index: Option<f64>,
    pub reasoning_effort: Option<&'a ReasoningEffort>,
    pub requested_output_tokens: Option<f64>,
    pub budget_state: Option<&'a PromptUsageBudgetState>,
    pub budget_state_source: Option<&'a dyn PromptBudgetStateSource>,
    pub prompt_sections: Option<&'a [PromptUsageSectionAttribution]>,
}

pub struct PromptUsageMetricInput<'a> {
    pub model: &'a str,
    pub scope: &'a str,
    pub prompt_tokens: Option<f64>,
    pub cached_tokens: f64,
    pub total_tokens: Option<f64>,
    /// Outer `None` is absent; inner `None` is explicit null.
    pub cache_write_tokens: Option<Option<f64>>,
    pub prompt_cache_key: Option<&'a str>,
    pub prompt_cache_retention: Option<PromptCacheRetention>,
    pub butler_data: Option<&'a str>,
    pub usage_attribution: Option<&'a PromptUsageAttribution<'a>>,
}

pub trait PromptUsageMetricSink: Send + Sync {
    fn append(&self, input: PromptUsageMetricInput<'_>) -> Result<(), ModelRoundError>;
}
