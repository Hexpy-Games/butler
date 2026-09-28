//! Durable edit_file effect over the registered native mutation capability.

mod normalized;
mod outcome;
#[cfg(test)]
pub(crate) mod tests;

use std::sync::Arc;

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::contracts::*;
use crate::workspace::EffectFileScope;
use normalized::EditInput;

/// Workspace file edits as effects.
pub struct WorkspaceFileEditEffectAdapter {
    scope: EffectFileScope,
    registered: Arc<dyn RegisteredEditPort>,
}

impl WorkspaceFileEditEffectAdapter {
    /// An adapter confined to `scope` that edits through the registered port.
    pub fn new(scope: EffectFileScope, registered: Arc<dyn RegisteredEditPort>) -> Self {
        Self { scope, registered }
    }
}

impl EffectAdapter for WorkspaceFileEditEffectAdapter {
    fn capability(&self) -> &'static str {
        "edit_file"
    }
    fn binding(&self) -> PlanBinding {
        PlanBinding::AcceptedPlan
    }
    fn normalize_target(&self, target: &str) -> EffectResult<String> {
        normalized::target(target)
    }
    fn sanitize_target(&self, target: &str) -> EffectResult<String> {
        Ok(target.into())
    }
    // Passthrough: EffectAdapter input is capability-generic tool input.
    fn normalize_input(&self, input: &Value) -> EffectResult<Value> {
        let normalized = normalized::input(input, &self.scope)?;
        serde_json::to_value(normalized).map_err(|source| invalid_input(&source))
    }
    // Passthrough: EffectAdapter input is capability-generic tool input.
    fn recovery_hint(&self, input: &Value) -> EffectResult<Option<RecoveryHint>> {
        let input = EditInput::decode(input).map_err(|source| invalid_input(&source))?;
        Ok(Some(normalized::recovery_hint(&input)))
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
            let input = match EditInput::decode(input) {
                Ok(input) => input,
                Err(source) => return Ok(AdapterOutcome::NotApplied(decode_error(&source))),
            };
            outcome::dispatch(&self.scope, &*self.registered, target, &input, signal).await
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
        prior: Option<&'a EffectError>,
    ) -> EffectFuture<'a, AdapterOutcome> {
        Box::pin(async move {
            let input = match EditInput::decode(input) {
                Ok(input) => input,
                Err(source) => return Ok(AdapterOutcome::Uncertain(Some(decode_error(&source)))),
            };
            outcome::reconcile(&self.scope, target, &input, attempts, prior).await
        })
    }
}

fn invalid_input(source: &serde_json::Error) -> EffectFailure {
    EffectFailure::policy(
        "effect_request_invalid",
        format!("edit_file normalized input is invalid: {source}"),
    )
}

fn decode_error(source: &serde_json::Error) -> EffectAdapterError {
    EffectAdapterError::new(
        "edit_file_input_invalid",
        format!("edit_file normalized input is invalid: {source}"),
    )
}

/// The effect target of a batched edit of `paths`.
pub fn batch_target(paths: &[String]) -> EffectResult<String> {
    normalized::batch_target(paths)
}
