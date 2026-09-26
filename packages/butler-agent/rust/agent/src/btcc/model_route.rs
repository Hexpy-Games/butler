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

#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;

pub(crate) use admission::{
    ModelRequestAdmissionCode, ModelRequestAdmissionError, ModelRequestContextPlan,
    RequestContextAdmission, RequestContextMeasurement,
};
#[cfg(test)]
pub(crate) use contracts::ModelExecutionView;
pub(crate) use contracts::{
    ContextSizing, ContextSizingRequest, ModelExecution, ModelExecutionFactory,
    ModelExecutionInput, ModelRouteRetryConfig, ProviderRequestError,
};
pub(crate) use execution::TurnModelExecutionFactory;
pub(crate) use source_revision::GuidedSourceRevision;

pub(crate) fn reduce_model_error(
    error: crate::btcc::agent_loop::ModelRoundError,
) -> crate::btcc::agent_loop::ModelRoundError {
    failure::reduce(error)
}
