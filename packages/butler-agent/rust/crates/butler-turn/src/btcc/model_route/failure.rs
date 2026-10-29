use crate::btcc::agent_loop::ModelRoundError;
use crate::btcc::{BtccError, RuntimeFailure};

use super::contracts::{FailureDisposition, ProviderRequestError};
use crate::btcc::BtccCode;

const ADVANCE: &[&str] = &[
    "provider_quota_exhausted",
    "provider_model_not_found",
    "provider_model_retired",
    "provider_model_unavailable",
    "provider_unsupported_model",
    "provider_tools_unsupported",
];
const RETRY: &[&str] = &[
    "provider_plan_usage_unavailable",
    "provider_auth_refresh_unavailable",
    "provider_empty_response",
    "provider_network_error",
    "provider_protocol_error",
    "provider_rate_limited",
    "provider_round_timeout",
    "provider_stream_interrupted",
];
const SURFACE: &[&str] = &[
    "chatgpt_sign_in_required",
    "chatgpt_plan_not_enabled",
    "chatgpt_store_unreadable",
    "provider_plan_not_eligible",
    "provider_plan_not_authorized",
    "provider_route_not_supported",
    "provider_unsupported_capability",
    "provider_unsupported_input",
    "provider_response_incomplete",
    "provider_response_refused",
    "provider_stop_unrecognized",
    "provider_output_truncated",
    "admission_invariant_violation",
    "provider_auth_error",
    "provider_context_limit_exceeded",
    "provider_invalid_request",
    "provider_permission_error",
    "provider_safety_error",
];

pub(super) fn classify(error: &ModelRoundError) -> FailureDisposition {
    let ModelRoundError::Provider(error) = error else {
        return FailureDisposition::Surface;
    };
    if SURFACE.contains(&error.code.as_str()) {
        return FailureDisposition::Surface;
    }
    if ADVANCE.contains(&error.code.as_str()) {
        return FailureDisposition::Advance;
    }
    if matches!(
        error.status_code,
        Some(400 | 401 | 403 | 405 | 406 | 409 | 415 | 422)
    ) {
        return FailureDisposition::Surface;
    }
    if matches!(error.status_code, Some(408 | 429 | 500..=599))
        || RETRY.contains(&error.code.as_str())
    {
        return FailureDisposition::Retry;
    }
    FailureDisposition::Surface
}

pub(super) fn code(error: &ModelRoundError) -> &str {
    match error {
        ModelRoundError::Provider(error) => &error.code,
        ModelRoundError::DispatchLimit => "model_route_dispatch_limit_exceeded",
        _ => "provider_unknown_error",
    }
}

/// A model-round error reduced to the two outcomes the agent loop reports.
pub(crate) enum ReducedModelError {
    Operational(RuntimeFailure),
    Integrity(BtccError),
}

pub(super) fn reduce_outer(error: ModelRoundError) -> ReducedModelError {
    match error {
        ModelRoundError::Operational(failure) => ReducedModelError::Operational(failure),
        ModelRoundError::Integrity(error) => ReducedModelError::Integrity(error),
        ModelRoundError::Provider(provider) => {
            ReducedModelError::Operational(provider_runtime(&provider))
        }
        ModelRoundError::Recovered {
            failure_code,
            disposition,
        } => ReducedModelError::Operational(RuntimeFailure::new(
            failure_code,
            disposition == "retry",
        )),
        ModelRoundError::Cancelled => {
            ReducedModelError::Operational(RuntimeFailure::new("turn_cancelled", false))
        }
        ModelRoundError::RequestAdmission(_)
        | ModelRoundError::StablePrefix(_)
        | ModelRoundError::ImageAdmission { .. } => {
            ReducedModelError::Operational(RuntimeFailure::new("gateway_failed", false))
        }
        ModelRoundError::InvocationFailure { .. } | ModelRoundError::DispatchLimit => {
            ReducedModelError::Operational(RuntimeFailure::new("gateway_failed", true))
        }
    }
}

pub(super) fn reduce(error: ModelRoundError) -> ModelRoundError {
    match reduce_outer(error) {
        ReducedModelError::Operational(failure) => ModelRoundError::Operational(failure),
        ReducedModelError::Integrity(error) => ModelRoundError::Integrity(error),
    }
}

fn provider_runtime(error: &ProviderRequestError) -> RuntimeFailure {
    RuntimeFailure {
        code: error.code.clone(),
        retryable: error.retryable,
        status_code: error.status_code,
        cause: error.cause.clone(),
    }
}

pub(super) fn durability(phase: &str, error: &BtccError) -> ModelRoundError {
    ModelRoundError::Integrity(BtccError::detected(
        BtccCode::ModelRouteDurabilityFailure,
        format!("BTCC model route durability failed during {phase}: {error}"),
    ))
}
