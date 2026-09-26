//! Reviewed write_file effect over the real registered capability port.

mod path;
#[cfg(test)]
mod tests;

use std::sync::Arc;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::contracts::*;
use crate::workspace::{
    EffectFileObservation, EffectFileScope, guard_effect_file, observe_effect_file,
};

pub(crate) struct WorkspaceFileEffectAdapter {
    scope: EffectFileScope,
    registered: Arc<dyn RegisteredWritePort>,
}
impl WorkspaceFileEffectAdapter {
    pub(crate) fn new(scope: EffectFileScope, registered: Arc<dyn RegisteredWritePort>) -> Self {
        Self { scope, registered }
    }
}

pub(crate) fn normalized_workspace_effect_path(
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

fn adapter_error(code: &str, message: impl Into<String>) -> EffectAdapterError {
    EffectAdapterError::new(code, message)
}
fn workspace_error(error: &crate::workspace::EffectFileError) -> EffectAdapterError {
    adapter_error(&error.code, error.message)
}
fn mismatch(target: &str, input: &Value) -> Option<EffectAdapterError> {
    let path = input.get("path").and_then(Value::as_str).unwrap_or("");
    (target != format!("workspace:{path}")).then(|| {
        adapter_error(
            "write_file_target_input_mismatch",
            "write_file target does not match its normalized path.",
        )
    })
}
fn expected_sha(input: &Value) -> String {
    let content = input.get("content").and_then(Value::as_str).unwrap_or("");
    format!("{:x}", Sha256::digest(content.as_bytes()))
}
fn caller_precondition(
    input: &Value,
    before: &EffectFileObservation,
) -> Option<EffectAdapterError> {
    let overwrite = input.get("overwrite").and_then(Value::as_bool);
    let expected = input.get("expected_sha256").and_then(Value::as_str);
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
fn observed_result(
    input: &Value,
    observation: &EffectFileObservation,
    created: bool,
    registered: Option<&Value>,
) -> Option<AdapterOutcome> {
    let EffectFileObservation::File { bytes, sha256 } = observation else {
        return None;
    };
    if *sha256 != expected_sha(input) {
        return None;
    }
    let mut result = json!({
        "ok":true,"effect":"workspace_file_write",
        "path":input["path"],"bytes":bytes,"after_sha256":sha256,
        "create_parents":input["create_parents"],"target_observed":true
    });
    if created {
        result["created_from_absent"] = json!(true);
    }
    if let Some(detail) = registered
        .and_then(Value::as_object)
        .and_then(|record| record.get("changed_file"))
        .filter(|detail| detail.is_object())
    {
        result["changed_file"] = detail.clone();
    }
    // A receipt built from JSON values always encodes; a failure means no observation.
    let receipt = crate::json::JsonDocument::from_value(&result).ok()?;
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
    fn normalize_input(&self, input: &Value) -> EffectResult<Value> {
        path::input(input, &self.scope.workspace)
    }
    fn dispatch<'a>(
        &'a self,
        target: &'a str,
        input: &'a Value,
        _key: &'a str,
        signal: &'a CancellationToken,
    ) -> EffectFuture<'a, AdapterOutcome> {
        Box::pin(async move {
            if let Some(error) = mismatch(target, input) {
                return Ok(AdapterOutcome::NotApplied(error));
            }
            let guarded =
                match guard_effect_file(&self.scope, input["path"].as_str().unwrap_or("")).await {
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
            if let Some(error) = caller_precondition(input, &before) {
                return Ok(AdapterOutcome::NotApplied(error));
            }
            let prepared = PreparedWrite {
                path: input["path"].as_str().unwrap_or("").into(),
                content: input["content"].as_str().unwrap_or("").into(),
                create_parents: input["create_parents"].as_bool().unwrap_or(false),
                overwrite: input
                    .get("overwrite")
                    .and_then(Value::as_bool)
                    .unwrap_or(matches!(before, EffectFileObservation::File { .. })),
                expected_sha256: input
                    .get("expected_sha256")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| match &before {
                        EffectFileObservation::File { sha256, .. } => Some(sha256.clone()),
                        _ => None,
                    }),
            };
            let registered = self.registered.write(prepared).await?;
            let after = observe_effect_file(&guarded).await;
            if (input.get("overwrite").is_some() || input.get("expected_sha256").is_some())
                && let Some(error) = rejection(&registered)
            {
                return Ok(AdapterOutcome::NotApplied(error));
            }
            if let Some(applied) = observed_result(
                input,
                &after,
                matches!(before, EffectFileObservation::Missing),
                Some(&registered),
            ) {
                return Ok(applied);
            }
            if let Some(error) = rejection(&registered) {
                return Ok(AdapterOutcome::NotApplied(error));
            }
            Ok(AdapterOutcome::Uncertain(Some(observation_error(after))))
        })
    }
    fn reconcile<'a>(
        &'a self,
        target: &'a str,
        input: &'a Value,
        _key: &'a str,
        _signal: &'a CancellationToken,
        attempts: i64,
        _prior: Option<&'a EffectError>,
    ) -> EffectFuture<'a, AdapterOutcome> {
        Box::pin(async move {
            if let Some(error) = mismatch(target, input) {
                return Ok(AdapterOutcome::Uncertain(Some(error)));
            }
            let guarded = match guard_effect_file(&self.scope, input["path"].as_str().unwrap_or(""))
                .await
            {
                Ok(value) => value,
                Err(error) => return Ok(AdapterOutcome::Uncertain(Some(workspace_error(&error)))),
            };
            let observed = observe_effect_file(&guarded).await;
            if attempts == 0
                && (input.get("overwrite").is_some() || input.get("expected_sha256").is_some())
            {
                return Ok(AdapterOutcome::NotApplied(adapter_error(
                    "not_applied",
                    "not applied",
                )));
            }
            if let Some(applied) = observed_result(input, &observed, false, None) {
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
