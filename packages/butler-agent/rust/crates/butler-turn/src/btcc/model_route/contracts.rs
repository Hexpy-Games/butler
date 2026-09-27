use std::{future::Future, pin::Pin};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::btcc::agent_loop::{ModelRoundMessage, ModelRoundObserver, ModelRoundPort};
use crate::btcc::{
    AgentLoopProgress, BtccError, ModelIdentity, ReasoningEffort, StateExecutionClaim, TurnRecord,
};

/// A provider request failure, persisted with the turn's model route history.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{code}: {message}")]
pub struct ProviderRequestError {
    pub code: String,
    pub message: String,
    pub provider: String,
    pub api: String,
    pub status_code: Option<u16>,
    pub endpoint: Option<String>,
    pub model: Option<String>,
    pub retryable: bool,
    pub cause: Option<String>,
    pub request_generation: Option<u64>,
    pub measured_input_tokens: Option<u64>,
    pub registered_input_capacity: Option<u64>,
    pub request_hash: Option<String>,
    pub timeout_kind: Option<String>,
    pub retry_at: Option<String>,
    pub provider_request_id: Option<String>,
    pub rate_limit: Option<Box<Value>>,
    pub provider_error_code: Option<String>,
    pub provider_error_type: Option<String>,
    pub provider_error_details: Option<Box<Value>>,
}

pub struct ContextSizingRequest<'a> {
    pub model: &'a str,
    pub instructions: Option<&'a str>,
    pub tools: &'a [crate::btcc::agent_loop::ModelRoundTool],
    pub attachments: &'a [Value],
    pub max_output_tokens: Option<f64>,
    pub butler_data: Option<&'a str>,
}

pub struct ContextSizing<'a> {
    pub max_output_tokens: Option<f64>,
    pub max_message_bytes: f64,
    pub measure: Box<ContextMeasure<'a>>,
}

pub(crate) type ContextMeasure<'a> =
    dyn Fn(&[ModelRoundMessage]) -> Result<f64, BtccError> + Send + Sync + 'a;

pub struct ModelExecutionInput<'a> {
    pub turn: &'a TurnRecord,
    pub claim: &'a StateExecutionClaim,
    pub progress: &'a dyn AgentLoopProgress,
    pub model_round_observer: &'a dyn ModelRoundObserver,
    pub cancellation: CancellationToken,
    pub base: &'a dyn ModelRoundPort,
    pub source_revision: super::GuidedSourceRevision,
}

#[derive(Clone, Copy, Debug)]
pub struct ModelRouteRetryConfig {
    pub base_delay_ms: f64,
}

impl ModelRouteRetryConfig {
    pub fn new(base_delay_ms: f64) -> Self {
        Self {
            base_delay_ms: if base_delay_ms.is_finite() {
                base_delay_ms.max(0.0)
            } else {
                750.0
            },
        }
    }
}

pub trait ModelExecutionFactory: Send + Sync {
    fn create<'a>(&self, input: ModelExecutionInput<'a>) -> ModelExecutionFuture<'a>;
}

pub(crate) type ModelExecutionFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Box<dyn ModelExecution + 'a>, BtccError>> + Send + 'a>>;

pub trait ModelExecutionView: Send + Sync {
    fn active_model_ref(&self) -> String;
    fn selected_reasoning_effort(&self) -> ReasoningEffort;
    fn accepted_model_identity(&self) -> Option<ModelIdentity>;
}

pub trait ModelExecution: ModelExecutionView {
    fn routed(&self) -> &dyn ModelRoundPort;
    fn base(&self) -> &dyn ModelRoundPort;
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RouteState {
    pub schema_version: String,
    pub route_digest: String,
    pub candidates: Vec<RouteCandidate>,
    pub retry_ceiling: u32,
    pub catalog_generation: String,
    pub active_cursor: u32,
    #[serde(default)]
    pub consumed_attempts: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RouteCandidate {
    pub model_ref: String,
    pub reasoning_effort: ReasoningEffort,
}

pub(super) use crate::btcc::turn::{AttemptHistory, FailureDisposition, FailureRecord};
