//! Reviewed write_file effect over the real registered capability port.

mod path;
#[cfg(test)]
mod tests;

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::contracts::*;
use crate::workspace::{
    EffectFileObservation, EffectFileScope, guard_effect_file, observe_effect_file,
};

/// Workspace file writes as effects.
pub struct WorkspaceFileEffectAdapter {
    scope: EffectFileScope,
    registered: Arc<dyn RegisteredWritePort>,
}
impl WorkspaceFileEffectAdapter {
    /// An adapter confined to `scope` that writes through the registered port.
    pub fn new(scope: EffectFileScope, registered: Arc<dyn RegisteredWritePort>) -> Self {
        Self { scope, registered }
    }
}

/// The contained workspace path an effect targets.
pub fn normalized_workspace_effect_path(
    scope: &EffectFileScope,
    path: &str,
) -> super::contracts::EffectResult<String> {
    path::contained(&scope.workspace, path)
}
pub(crate) fn normalized_workspace_effect_target(
    target: &str,
) -> super::contracts::EffectResult<String> {
    path::target(target)
}

/// The normalized input of a write_file effect. Field order and the omitted
/// optional fields are the journaled (identity-hashed) form.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub(super) struct WriteInput {
    pub(super) path: String,
    pub(super) content: String,
    pub(super) create_parents: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) overwrite: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) expected_sha256: Option<String>,
}

impl WriteInput {
    /// Decodes a journaled normalized input.
    // Passthrough: parse boundary validating untyped JSON into typed values.
    fn decode(input: &Value) -> Result<Self, EffectAdapterError> {
        Self::deserialize(input).map_err(|error| {
            adapter_error(
                "write_file_input_invalid",
                format!("write_file normalized input is invalid: {error}"),
            )
        })
    }

    /// Whether the caller stated a precondition (overwrite or expected digest).
    fn caller_bound(&self) -> bool {
        self.overwrite.is_some() || self.expected_sha256.is_some()
    }
}

fn adapter_error(code: &str, message: impl Into<String>) -> EffectAdapterError {
    EffectAdapterError::new(code, message)
}
fn workspace_error(error: &crate::workspace::EffectFileError) -> EffectAdapterError {
    adapter_error(error.code(), error.message())
}
fn mismatch(target: &str, input: &WriteInput) -> Option<EffectAdapterError> {
    (target != format!("workspace:{}", input.path)).then(|| {
        adapter_error(
            "write_file_target_input_mismatch",
            "write_file target does not match its normalized path.",
        )
    })
}
fn expected_sha(input: &WriteInput) -> String {
    format!("{:x}", Sha256::digest(input.content.as_bytes()))
}
fn caller_precondition(
    input: &WriteInput,
    before: &EffectFileObservation,
) -> Option<EffectAdapterError> {
    let overwrite = input.overwrite;
    let expected = input.expected_sha256.as_deref();
    match before {
        EffectFileObservation::File { sha256, .. } => {
            if overwrite == Some(false) {
                return Some(adapter_error(
                    "file_exists",
                    "The target already exists and overwrite=false.",
                ));
            }
            if expected.is_some_and(|value| value != sha256) {
                return Some(adapter_error(
                    "expected_sha256_mismatch",
                    "The target no longer matches expected_sha256.",
                ));
            }
            if overwrite == Some(true) && expected.is_none() {
                return Some(adapter_error(
                    "expected_sha256_required",
                    "Replacement requires current expected_sha256.",
                ));
            }
        }
        EffectFileObservation::Missing => {
            if overwrite == Some(true) {
                return Some(adapter_error(
                    "invalid_arguments",
                    "Creation requires overwrite=false.",
                ));
            }
            if expected.is_some() {
                return Some(adapter_error(
                    "expected_sha256_on_missing_file",
                    "The target is missing for expected_sha256.",
                ));
            }
        }
        EffectFileObservation::Unavailable(_) => {}
    }
    None
}
/// How an observed write came about: from an absent target and, on
/// dispatch, with the registered tool's receipt (passthrough JSON).
struct Observed<'a> {
    created: bool,
    // Passthrough: tool/effect receipts, shaped by the capability.
    registered: Option<&'a Value>,
}

fn observed_result(
    input: &WriteInput,
    observation: &EffectFileObservation,
    Observed {
        created,
        registered,
    }: Observed<'_>,
) -> Option<AdapterOutcome> {
    let EffectFileObservation::File { bytes, sha256 } = observation else {
        return None;
    };
    if *sha256 != expected_sha(input) {
        return None;
    }
    let mut result = json!({
        "ok":true,"effect":"workspace_file_write",
        "path":input.path,"bytes":bytes,"after_sha256":sha256,
        "create_parents":input.create_parents,"target_observed":true
    });
    if created {
        butler_core::json::object_mut(&mut result)
            .insert("created_from_absent".into(), json!(true));
    }
    if let Some(detail) = registered
        .and_then(Value::as_object)
        .and_then(|record| record.get("changed_file"))
        .filter(|detail| detail.is_object())
    {
        butler_core::json::object_mut(&mut result).insert("changed_file".into(), detail.clone());
    }
    // A receipt built from JSON values always encodes; a failure means no observation.
    let receipt = butler_core::json::JsonDocument::from_value(&result).ok()?;
    Some(AdapterOutcome::Applied(receipt))
}
fn observation_error(observation: EffectFileObservation) -> EffectAdapterError {
    match observation {
        EffectFileObservation::Unavailable(error) => workspace_error(&error),
        _ => adapter_error(
            "workspace_file_state_mismatch",
            "Current target bytes do not prove whether write_file was applied.",
        ),
    }
}
/// The registered tool's rejection in its receipt (passthrough JSON).
fn rejection(value: &Value) -> Option<EffectAdapterError> {
    let record = value.as_object()?;
    if record.get("ok") != Some(&Value::Bool(false)) {
        return None;
    }
    let code = record
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("registered_write_file_rejected");
    Some(adapter_error(
        code,
        "The registered write_file tool rejected the target or input.",
    ))
}

impl EffectAdapter for WorkspaceFileEffectAdapter {
    fn capability(&self) -> &'static str {
        "write_file"
    }
    fn binding(&self) -> PlanBinding {
        PlanBinding::AcceptedPlan
    }
    fn normalize_target(&self, target: &str) -> EffectResult<String> {
        path::target(target)
    }
    fn sanitize_target(&self, target: &str) -> EffectResult<String> {
        Ok(target.into())
    }
    // Passthrough: EffectAdapter input is capability-generic tool input.
    fn normalize_input(&self, input: &Value) -> EffectResult<Value> {
        let normalized = path::input(input, &self.scope.workspace)?;
        serde_json::to_value(normalized)
            .map_err(|source| EffectFailure::policy("effect_request_invalid", source.to_string()))
    }
    // Passthrough: EffectAdapter input is capability-generic tool input.
    fn dispatch<'a>(
        &'a self,
        target: &'a str,
        // Passthrough: EffectAdapter input is capability-generic tool input.
        input: &'a Value,
        _key: &'a str,
        signal: &'a CancellationToken,
    ) -> EffectFuture<'a, AdapterOutcome> {
        Box::pin(async move {
            let input = match WriteInput::decode(input) {
                Ok(input) => input,
                Err(error) => return Ok(AdapterOutcome::NotApplied(error)),
            };
            if let Some(error) = mismatch(target, &input) {
                return Ok(AdapterOutcome::NotApplied(error));
            }
            let guarded = match guard_effect_file(&self.scope, &input.path).await {
                Ok(value) => value,
                Err(error) => return Ok(AdapterOutcome::NotApplied(workspace_error(&error))),
            };
            if signal.is_cancelled() {
                return Ok(AdapterOutcome::NotApplied(adapter_error(
                    "write_file_cancelled",
                    "write_file was cancelled before registered tool dispatch.",
                )));
            }
            let before = observe_effect_file(&guarded).await;
            if let EffectFileObservation::Unavailable(error) = &before {
                return Ok(AdapterOutcome::Uncertain(Some(workspace_error(
                    &error.clone(),
                ))));
            }
            if let Some(error) = caller_precondition(&input, &before) {
                return Ok(AdapterOutcome::NotApplied(error));
            }
            let prepared = PreparedWrite {
                path: input.path.clone(),
                content: input.content.clone(),
                create_parents: input.create_parents,
                overwrite: input
                    .overwrite
                    .unwrap_or(matches!(before, EffectFileObservation::File { .. })),
                expected_sha256: input.expected_sha256.clone().or_else(|| match &before {
                    EffectFileObservation::File { sha256, .. } => Some(sha256.clone()),
                    _ => None,
                }),
            };
            let registered = self.registered.write(prepared).await?;
            let after = observe_effect_file(&guarded).await;
            if input.caller_bound()
                && let Some(error) = rejection(&registered)
            {
                return Ok(AdapterOutcome::NotApplied(error));
            }
            if let Some(applied) = observed_result(
                &input,
                &after,
                Observed {
                    created: matches!(before, EffectFileObservation::Missing),
                    registered: Some(&registered),
                },
            ) {
                return Ok(applied);
            }
            if let Some(error) = rejection(&registered) {
                return Ok(AdapterOutcome::NotApplied(error));
            }
            Ok(AdapterOutcome::Uncertain(Some(observation_error(after))))
        })
    }
    // Passthrough: EffectAdapter input is capability-generic tool input.
    fn reconcile<'a>(
        &'a self,
        target: &'a str,
        // Passthrough: EffectAdapter input is capability-generic tool input.
        input: &'a Value,
        _key: &'a str,
        _signal: &'a CancellationToken,
        attempts: i64,
        _prior: Option<&'a EffectError>,
    ) -> EffectFuture<'a, AdapterOutcome> {
        Box::pin(async move {
            let input = match WriteInput::decode(input) {
                Ok(input) => input,
                Err(error) => return Ok(AdapterOutcome::Uncertain(Some(error))),
            };
            if let Some(error) = mismatch(target, &input) {
                return Ok(AdapterOutcome::Uncertain(Some(error)));
            }
            let guarded = match guard_effect_file(&self.scope, &input.path).await {
                Ok(value) => value,
                Err(error) => return Ok(AdapterOutcome::Uncertain(Some(workspace_error(&error)))),
            };
            let observed = observe_effect_file(&guarded).await;
            if attempts == 0 && input.caller_bound() {
                return Ok(AdapterOutcome::NotApplied(adapter_error(
                    "not_applied",
                    "not applied",
                )));
            }
            let unregistered = Observed {
                created: false,
                registered: None,
            };
            if let Some(applied) = observed_result(&input, &observed, unregistered) {
                return Ok(applied);
            }
            if attempts == 0 {
                return Ok(AdapterOutcome::NotApplied(adapter_error(
                    "not_applied",
                    "not applied",
                )));
            }
            Ok(AdapterOutcome::Uncertain(Some(observation_error(observed))))
        })
    }
}
