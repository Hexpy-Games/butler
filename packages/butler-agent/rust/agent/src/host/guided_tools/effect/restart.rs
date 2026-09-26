//! Durable request only; the service owner runs the handoff after final delivery.

use std::sync::Arc;

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::{
    btcc::{AdapterOutcome, EffectAdapter, EffectFailure, EffectFuture, PlanBinding},
    json::JsonDocument,
};

use super::NativeGuidedTools;

const CAPABILITY: &str = "request_service_restart";
const TARGET: &str = "butler-agent-native";

pub(super) fn prepare(
    owner: &NativeGuidedTools,
    args: &serde_json::Map<String, Value>,
) -> Result<(String, Value, Arc<dyn EffectAdapter>), crate::btcc::BtccError> {
    if owner.binding.app_session_id.is_none() {
        return Err(crate::btcc::BtccError::new(
            "restart_app_turn_required",
            "A delivered App Turn is required for a service restart request.",
        ));
    }
    if !args.is_empty() {
        return Err(crate::btcc::BtccError::new(
            "restart_request_invalid",
            "This restart request takes no arguments.",
        ));
    }
    Ok((TARGET.into(), json!({}), Arc::new(RestartRequest)))
}

struct RestartRequest;

impl EffectAdapter for RestartRequest {
    fn capability(&self) -> &str {
        CAPABILITY
    }

    fn binding(&self) -> PlanBinding {
        PlanBinding::AcceptedPlan
    }

    fn normalize_target(&self, target: &str) -> Result<String, EffectFailure> {
        (target == TARGET)
            .then(|| TARGET.to_owned())
            .ok_or_else(|| invalid("restart_target_invalid"))
    }

    fn sanitize_target(&self, target: &str) -> Result<String, EffectFailure> {
        self.normalize_target(target)?;
        Ok("Butler native service".into())
    }

    fn normalize_input(&self, input: &Value) -> Result<Value, EffectFailure> {
        input
            .as_object()
            .filter(|value| value.is_empty())
            .map(|_| json!({}))
            .ok_or_else(|| invalid("restart_request_invalid"))
    }

    fn dispatch<'a>(
        &'a self,
        _: &'a str,
        _: &'a Value,
        key: &'a str,
        signal: &'a CancellationToken,
    ) -> EffectFuture<'a, AdapterOutcome> {
        Box::pin(async move { pending(key, signal) })
    }

    fn reconcile<'a>(
        &'a self,
        _: &'a str,
        _: &'a Value,
        key: &'a str,
        signal: &'a CancellationToken,
        _: i64,
        _: Option<&'a crate::btcc::EffectError>,
    ) -> EffectFuture<'a, AdapterOutcome> {
        Box::pin(async move { pending(key, signal) })
    }
}

fn pending(key: &str, signal: &CancellationToken) -> Result<AdapterOutcome, EffectFailure> {
    if signal.is_cancelled() {
        return Ok(AdapterOutcome::NotApplied(
            crate::btcc::EffectAdapterError::new(
                "restart_request_cancelled",
                "Restart was not requested.",
            ),
        ));
    }
    let result = JsonDocument::from_value(&json!({
        "ok":true,
        "requested":true,
        "status":"pending",
        "restarted":false,
        "handoff_request_id":key,
    }))
    .map_err(|error| EffectFailure::adapter(error.to_string()))?;
    Ok(AdapterOutcome::Applied(result))
}

fn invalid(code: &str) -> EffectFailure {
    EffectFailure::policy(code, "Invalid native service restart request")
}
