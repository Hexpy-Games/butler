use serde_json::Value;

use crate::btcc::agent_loop::{ModelRoundError, ModelRoundRequest, ModelRoundResult};
use crate::btcc::{BtccError, ModelIdentity, ReasoningEffort};

use super::contracts::{AttemptHistory, FailureDisposition, FailureRecord, RouteState};
use crate::btcc::BtccCode;

pub(super) fn event(
    kind: &str,
    round: &str,
    candidate: u32,
    attempt: Option<u32>,
    model: &str,
    failure: Option<(&str, FailureDisposition)>,
) -> Value {
    let mut object = crate::json::json_object!(
        {"type":kind,"roundId":round,"candidateIndex":candidate,"modelRef":model}
    );
    if let Some(attempt) = attempt {
        object.insert("transportAttempt".into(), Value::from(attempt));
    }
    if let Some((code, disposition)) = failure {
        object.insert("errorCode".into(), Value::String(code.into()));
        object.insert(
            "failureDisposition".into(),
            Value::String(disposition.as_str().into()),
        );
    }
    Value::Object(object)
}
pub(super) fn status(value: Option<&Value>) -> Option<&str> {
    value.as_ref()?.get("status")?.as_str()
}
pub(super) fn max_attempt(history: &AttemptHistory) -> u32 {
    history
        .started
        .iter()
        .chain(&history.failed)
        .chain(&history.succeeded)
        .chain(&history.abandoned)
        .copied()
        .max()
        .unwrap_or(0)
}
pub(super) fn latest_failure(history: &AttemptHistory) -> Option<&FailureRecord> {
    history
        .failed_details
        .iter()
        .max_by_key(|v| v.transport_attempt)
        .filter(|v| v.transport_attempt == max_attempt(history))
}
pub(super) fn recovered(value: &FailureRecord) -> ModelRoundError {
    ModelRoundError::Recovered {
        failure_code: value.error_code.clone(),
        disposition: format!("{:?}", value.disposition).to_lowercase(),
    }
}

pub(super) fn selected(value: &Value) -> Result<(String, ReasoningEffort), BtccError> {
    let provider = value
        .get("provider")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            BtccError::detected(BtccCode::InvalidAdmittedModelSelection, "missing provider")
        })?;
    let model = value.get("model").and_then(Value::as_str).ok_or_else(|| {
        BtccError::detected(BtccCode::InvalidAdmittedModelSelection, "missing model")
    })?;
    let reasoning = serde_json::from_value(
        value
            .get("reasoningEffort")
            .cloned()
            .unwrap_or(Value::String("medium".into())),
    )
    .map_err(|source| {
        BtccError::detected(
            BtccCode::InvalidAdmittedModelSelection,
            "invalid reasoning effort",
        )
        .with_source(source)
    })?;
    Ok((format!("{provider}/{model}"), reasoning))
}
pub(super) fn validate(route: &RouteState) -> Result<(), BtccError> {
    if route.schema_version != "butler.model-route.v1"
        || route.candidates.is_empty()
        || route.candidates.len() > 6
        || !(1..=5).contains(&route.retry_ceiling)
        || route.active_cursor as usize >= route.candidates.len()
    {
        return Err(BtccError::detected(
            BtccCode::ModelRouteInvalid,
            "invalid admitted model route",
        ));
    }
    Ok(())
}
pub(super) fn visual_freeze(image: Option<&Value>, model: &str) -> Result<(), ModelRoundError> {
    let Some(image) = image else {
        return Ok(());
    };
    let frozen = format!(
        "{}/{}",
        image
            .get("providerId")
            .and_then(Value::as_str)
            .unwrap_or(""),
        image.get("modelId").and_then(Value::as_str).unwrap_or("")
    );
    if frozen != model {
        return Err(ModelRoundError::ImageAdmission {
            code: "image_model_unsupported".into(),
            reason: "visual_fallback_disabled".into(),
        });
    }
    Ok(())
}
pub(super) fn rebase_continuation<'a>(
    bounded: Option<&Value>,
    continuation: Option<&'a Value>,
) -> Result<Option<&'a Value>, ModelRoundError> {
    let Some(current) = bounded.and_then(|v| v.get("contextProjection")) else {
        return Ok(continuation);
    };
    let accepted = continuation
        .and_then(|v| v.as_object())
        .and_then(|v| v.get("contextProjection"));
    if accepted.is_some_and(|value| !projection_identity(value)) {
        return Err(ModelRoundError::Integrity(BtccError::detected(
            BtccCode::PhaseContinuityProjectionRebaseIdentityInvalid,
            "invalid accepted context projection identity",
        )));
    }
    let current_json = crate::json::stringify(current).map_err(|error| {
        ModelRoundError::Integrity(BtccError::detected(
            BtccCode::PhaseContinuityProjectionRebaseIdentityInvalid,
            error.to_string(),
        ))
    })?;
    let accepted_json =
        crate::json::stringify(accepted.unwrap_or(&Value::Null)).map_err(|error| {
            ModelRoundError::Integrity(BtccError::detected(
                BtccCode::PhaseContinuityProjectionRebaseIdentityInvalid,
                error.to_string(),
            ))
        })?;
    Ok((current_json == accepted_json)
        .then_some(continuation)
        .flatten())
}
pub(super) fn attach_surface(
    mut result: ModelRoundResult,
    digest: Option<&str>,
) -> Result<ModelRoundResult, ModelRoundError> {
    let Some(digest) = digest else {
        return Ok(result);
    };
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|v| v.is_ascii_hexdigit() && !v.is_ascii_uppercase())
    {
        return Err(ModelRoundError::Integrity(BtccError::detected(
            BtccCode::RoundToolSurfaceContinuationInvalid,
            "invalid round tool surface digest",
        )));
    }
    if let Some(value) = result.continuation.as_mut() {
        value
            .as_object_mut()
            .ok_or_else(|| {
                ModelRoundError::Integrity(BtccError::detected(
                    BtccCode::RoundToolSurfaceContinuationInvalid,
                    "invalid provider continuation",
                ))
            })?
            .insert("toolSurfaceDigest".into(), Value::String(digest.into()));
    }
    Ok(result)
}

fn projection_identity(value: &Value) -> bool {
    let Some(value) = value.as_object() else {
        return false;
    };
    let allowed = [
        "schemaVersion",
        "projectionRevision",
        "projectionDigest",
        "projectedThroughOrdinal",
    ];
    value.keys().all(|key| allowed.contains(&key.as_str()))
        && value.get("schemaVersion").and_then(Value::as_str)
            == Some("butler.context-projection-rebase.v1")
        && matches!(
            value.get("projectionRevision").and_then(Value::as_str),
            Some("butler.phase-continuity-projection.v1" | "butler.rolling-context.v1")
        )
        && value
            .get("projectionDigest")
            .and_then(Value::as_str)
            .is_some_and(|digest| {
                digest.len() == 64
                    && digest
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
        && value
            .get("projectedThroughOrdinal")
            .and_then(Value::as_u64)
            .is_some_and(|ordinal| ordinal <= 1_000_000)
}
pub(super) fn identity(
    request: &ModelRoundRequest<'_>,
    effective: &str,
    result: &ModelRoundResult,
) -> ModelIdentity {
    let reported = result.provider_identity.as_ref().map(|v| {
        if v.reported_model.contains('/') {
            v.reported_model.clone()
        } else {
            format!("{}/{}", v.provider, v.reported_model)
        }
    });
    ModelIdentity {
        requested_model_ref: request.model.into(),
        effective_model_ref: effective.into(),
        provider_reported_model_ref: reported,
    }
}
