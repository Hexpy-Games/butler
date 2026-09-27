use serde_json::json;

use super::super::contracts::FailureDisposition;
use super::super::failure;
use super::super::support::rebase_continuation;
use super::super::test_support::provider;
use crate::btcc::agent_loop::ModelRoundError;

#[test]
fn failure_policy_is_explicit_and_ambiguous_statuses_surface() {
    assert_eq!(
        failure::classify(&provider("provider_quota_exhausted", Some(402))),
        FailureDisposition::Advance
    );
    assert_eq!(
        failure::classify(&provider("provider_model_not_found", Some(400))),
        FailureDisposition::Advance
    );
    assert_eq!(
        failure::classify(&provider("provider_auth_error", Some(500))),
        FailureDisposition::Surface
    );
    assert_eq!(
        failure::classify(&provider("provider_network_error", Some(400))),
        FailureDisposition::Surface
    );
    assert_eq!(
        failure::classify(&provider("provider_network_error", None)),
        FailureDisposition::Retry
    );
    for status in [402, 404, 410] {
        assert_eq!(
            failure::classify(&provider("provider_api_error", Some(status))),
            FailureDisposition::Surface
        );
    }
    assert_eq!(
        failure::classify(&provider("provider_api_error", Some(500))),
        FailureDisposition::Retry
    );
}

#[test]
fn outer_failure_reduction_matches_turn_runtime_diagnostics() {
    let retry = failure::reduce(ModelRoundError::Recovered {
        failure_code: "provider_network_error".into(),
        disposition: "retry".into(),
    });
    assert!(matches!(
        retry,
        ModelRoundError::Operational(ref value)
            if value.code == "provider_network_error" && value.retryable
    ));
    for error in [
        ModelRoundError::RequestAdmission(Box::new(crate::btcc::ModelRequestAdmissionError {
            code: crate::btcc::ModelRequestAdmissionCode::ContextCapacityExceeded,
            message: "Serialized model request does not fit.".into(),
            plan: None,
        })),
        ModelRoundError::InvocationFailure {
            code: Some("EACCES".into()),
            message: "Metric append failed.".into(),
        },
        ModelRoundError::StablePrefix("stable_provider_prefix_contract_invalid".into()),
        ModelRoundError::ImageAdmission {
            code: "image_model_unsupported".into(),
            reason: "visual_fallback_disabled".into(),
        },
    ] {
        assert_eq!(failure::classify(&error), FailureDisposition::Surface);
        assert_eq!(failure::code(&error), "provider_unknown_error");
        assert!(matches!(
            failure::reduce(error),
            ModelRoundError::Operational(ref value)
                if value.code == "gateway_failed" && value.retryable
        ));
    }
    assert_eq!(
        failure::code(&ModelRoundError::DispatchLimit),
        "model_route_dispatch_limit_exceeded"
    );
    assert!(matches!(
        failure::reduce(ModelRoundError::DispatchLimit),
        ModelRoundError::Operational(ref value)
            if value.code == "gateway_failed" && value.retryable
    ));
}

#[test]
fn continuation_rebase_validates_only_accepted_identity_and_compares_json_bytes() {
    let current = json!({"projectionRevision":"butler.rolling-context.v1","schemaVersion":"butler.context-projection-rebase.v1","projectionDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","projectedThroughOrdinal":1});
    let bounded = json!({"contextProjection": current});
    let accepted_same_fields_different_order = json!({"contextProjection":{"schemaVersion":"butler.context-projection-rebase.v1","projectionRevision":"butler.rolling-context.v1","projectionDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","projectedThroughOrdinal":1}});
    assert_eq!(
        rebase_continuation(Some(&bounded), Some(&accepted_same_fields_different_order)).unwrap(),
        None
    );

    let opaque_current = json!({"unvalidatedCurrent":true});
    let opaque_bounded = json!({"contextProjection": opaque_current});
    assert_eq!(
        rebase_continuation(Some(&opaque_bounded), None).unwrap(),
        None
    );
    let invalid_accepted = json!({"contextProjection":{"unvalidatedAccepted":true}});
    assert!(matches!(
        rebase_continuation(Some(&bounded), Some(&invalid_accepted)),
        Err(ModelRoundError::Integrity(ref value))
            if value.code() == "phase_continuity_projection_rebase_identity_invalid"
    ));
}
