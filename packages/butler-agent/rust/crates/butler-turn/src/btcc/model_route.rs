//! Execution-local BTCC model routing and durable physical-round recovery.

mod admission;
mod contracts;
mod execution;
mod failure;
mod hooks;
mod projection;
mod routed;
mod source_revision;
mod support;

#[cfg(any(test, feature = "test-support"))]
mod test_support;
#[cfg(test)]
mod tests;

pub use admission::{
    ModelRequestAdmissionCode, ModelRequestAdmissionError, ModelRequestContextPlan,
    RequestContextAdmission, RequestContextMeasurement,
};
#[cfg(any(test, feature = "test-support"))]
pub use contracts::ModelExecutionView;
pub use contracts::{
    ContextMeasurement, ContextSizing, ContextSizingRequest, ModelExecution, ModelExecutionFactory,
    ModelExecutionInput, ModelRouteRetryConfig, ProviderRequestError,
};
pub use execution::TurnModelExecutionFactory;
pub use source_revision::GuidedSourceRevision;

pub(crate) use failure::ReducedModelError;

pub(crate) fn reduce_model_error(
    error: crate::btcc::agent_loop::ModelRoundError,
) -> ReducedModelError {
    failure::reduce_outer(error)
}
