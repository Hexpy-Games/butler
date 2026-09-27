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
    // Passthrough: provider payload, opaque to BTCC.
    pub rate_limit: Option<Box<Value>>,
    pub provider_error_code: Option<String>,
    pub provider_error_type: Option<String>,
    // Passthrough: provider payload, opaque to BTCC.
    pub provider_error_details: Option<Box<Value>>,
}

/// What context sizing needs to know about a request.
pub struct ContextSizingRequest<'a> {
    pub model: &'a str,
    pub instructions: Option<&'a str>,
    pub tools: &'a [crate::btcc::agent_loop::ModelRoundTool],
    // Passthrough: image admission and attachment documents owned by butler-runtime.
    pub attachments: &'a [Value],
    pub max_output_tokens: Option<f64>,
    pub butler_data: Option<&'a str>,
}

/// The message budget of a request and how to measure messages.
pub struct ContextSizing<'a> {
    pub max_output_tokens: Option<f64>,
    pub max_message_bytes: f64,
    pub measure: Box<ContextMeasure<'a>>,
}

pub(crate) type ContextMeasure<'a> =
    dyn Fn(&[ModelRoundMessage]) -> Result<f64, BtccError> + Send + Sync + 'a;

/// What a model execution borrows from the turn.
pub struct ModelExecutionInput<'a> {
    pub turn: &'a TurnRecord,
    pub claim: &'a StateExecutionClaim,
    pub progress: &'a dyn AgentLoopProgress,
    pub model_round_observer: &'a dyn ModelRoundObserver,
    pub cancellation: CancellationToken,
    pub base: &'a dyn ModelRoundPort,
    pub source_revision: super::GuidedSourceRevision,
}

/// Retry backoff of the model route.
#[derive(Clone, Copy, Debug)]
pub struct ModelRouteRetryConfig {
    pub base_delay_ms: f64,
}

impl ModelRouteRetryConfig {
    /// A config with `base_delay_ms` (non-finite values use 750 ms).
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

/// Creates the model execution of a turn.
pub trait ModelExecutionFactory: Send + Sync {
    /// The execution for the turn's admitted route.
    fn create<'a>(&self, input: ModelExecutionInput<'a>) -> ModelExecutionFuture<'a>;
}

pub(crate) type ModelExecutionFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Box<dyn ModelExecution + 'a>, BtccError>> + Send + 'a>>;

pub trait ModelExecutionView: Send + Sync {
    fn active_model_ref(&self) -> String;
    fn selected_reasoning_effort(&self) -> ReasoningEffort;
    fn accepted_model_identity(&self) -> Option<ModelIdentity>;
}

/// A turn's model execution: the routed port and the base port.
pub trait ModelExecution: ModelExecutionView {
    /// The port that applies the route (retries, fallback, acceptance).
    fn routed(&self) -> &dyn ModelRoundPort;
    /// The underlying provider port.
    fn base(&self) -> &dyn ModelRoundPort;
}

pub(super) use crate::btcc::turn::{AttemptHistory, FailureDisposition, FailureRecord};
pub(super) use crate::btcc::turn::{RouteCandidate, RouteState};
