//! Durable edit_file effect over the registered native mutation capability.

mod normalized;
mod outcome;

use std::sync::Arc;

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::contracts::*;
use crate::workspace::EffectFileScope;

pub(crate) struct WorkspaceFileEditEffectAdapter {
    scope: EffectFileScope,
    registered: Arc<dyn RegisteredEditPort>,
}

impl WorkspaceFileEditEffectAdapter {
    pub(crate) fn new(scope: EffectFileScope, registered: Arc<dyn RegisteredEditPort>) -> Self {
        Self { scope, registered }
    }
}

impl EffectAdapter for WorkspaceFileEditEffectAdapter {
    fn capability(&self) -> &str {
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
    fn normalize_input(&self, input: &Value) -> EffectResult<Value> {
        normalized::input(input, &self.scope)
    }
    fn recovery_hint(&self, input: &Value) -> EffectResult<Option<RecoveryHint>> {
        normalized::recovery_hint(input).map(Some)
    }
    fn dispatch<'a>(
        &'a self,
        target: &'a str,
        input: &'a Value,
        _key: &'a str,
        signal: &'a CancellationToken,
    ) -> EffectFuture<'a, AdapterOutcome> {
        Box::pin(async move {
            outcome::dispatch(&self.scope, &*self.registered, target, input, signal).await
        })
    }
    fn reconcile<'a>(
        &'a self,
        target: &'a str,
        input: &'a Value,
        _key: &'a str,
        _signal: &'a CancellationToken,
        attempts: i64,
        prior: Option<&'a EffectError>,
    ) -> EffectFuture<'a, AdapterOutcome> {
        Box::pin(
            async move { outcome::reconcile(&self.scope, target, input, attempts, prior).await },
        )
    }
}

pub(crate) fn batch_target(paths: &[String]) -> EffectResult<String> {
    normalized::batch_target(paths)
}
