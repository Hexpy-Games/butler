use crate::btcc::agent_loop::ModelRoundError;
use crate::btcc::{BtccError, RuntimeFailure};

use super::contracts::{FailureDisposition, ProviderRequestError};

const ADVANCE: &[&str] = &[
    "provider_quota_exhausted",
    "provider_model_not_found",
    "provider_model_retired",
    "provider_model_unavailable",
    "provider_unsupported_model",
];
const RETRY: &[&str] = &[
    "provider_empty_response",
    "provider_network_error",
    "provider_protocol_error",
    "provider_rate_limited",
    "provider_round_timeout",
    "provider_stream_interrupted",
];
const SURFACE: &[&str] = &[
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
        } => ReducedModelError::Operational(RuntimeFailure {
            code: failure_code,
            retryable: disposition == "retry",
        }),
        ModelRoundError::Cancelled => ReducedModelError::Operational(RuntimeFailure {
            code: "turn_cancelled".into(),
            retryable: false,
        }),
        ModelRoundError::RequestAdmission(_)
        | ModelRoundError::InvocationFailure { .. }
        | ModelRoundError::StablePrefix(_)
        | ModelRoundError::ImageAdmission { .. }
        | ModelRoundError::DispatchLimit => ReducedModelError::Operational(RuntimeFailure {
            code: "gateway_failed".into(),
            retryable: true,
        }),
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
    }
}

pub(super) fn durability(phase: &str, error: BtccError) -> ModelRoundError {
    ModelRoundError::Integrity(BtccError::new(
        "model_route_durability_failure",
        format!("BTCC model route durability failed during {phase}: {error}"),
    ))
}
