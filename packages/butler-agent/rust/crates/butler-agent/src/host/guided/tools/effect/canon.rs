//! Reviewed board creation through the App's canon API and event owner.
mod input;

use super::super::GuidedTools;
use crate::host::automation::client::ScheduleClient;
use butler_core::{json::JsonDocument, tool_protocol::ToolName};
use butler_turn::btcc::{
    AdapterOutcome, BtccError, EffectAdapter, EffectAdapterError, EffectFailure, EffectFuture,
    ModelRoundToolCall, PlanBinding,
};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub(super) async fn prepare(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    occurrence: &str,
) -> Result<(String, Value, Arc<dyn EffectAdapter>), BtccError> {
    let mut input = Value::Object(call.arguments.clone());
    if !super::automation::restore_reviewed_input(owner, occurrence, &mut input).await? {
        input = input::resolve(owner, &input).await?;
    }
    let item = json!({"kind":input["canon"]["kind"],
        "project_id":input["canon"]["project_id"],"plan_id":input["body"]["plan_id"],
        "title":input["body"]["title"],"description":input["body"]["description"],
        "due_on":input["body"]["due_on"]});
    let digest = butler_turn::btcc::effect_input_sha256(&item)
        .map_err(|e| BtccError::relayed(e.code().to_owned(), e.message().to_owned()))?;
    let run = owner.inherited_run();
    let scope = run
        .as_ref()
        .map_or(owner.binding.turn_id.as_str(), |r| r.run_id.as_str());
    let target = format!("canon:create:{scope}:{digest}");
    let adapter = CanonEffect {
        endpoint: owner.app_endpoint.clone(),
        target: target.clone(),
    };
    Ok((target, input, Arc::new(adapter)))
}

struct CanonEffect {
    endpoint: Arc<crate::host::ActiveAppEndpoint>,
    target: String,
}

impl EffectAdapter for CanonEffect {
    fn capability(&self) -> &str {
        ToolName::CanonPropose.as_str()
    }
    fn binding(&self) -> PlanBinding {
        PlanBinding::AcceptedPlan
    }
    fn normalize_target(&self, target: &str) -> Result<String, EffectFailure> {
        if target != self.target {
            return Err(EffectFailure::policy(
                "canon_target_mismatch",
                "Board operation identity changed.",
            ));
        }
        Ok(target.to_owned())
    }
    fn sanitize_target(&self, target: &str) -> Result<String, EffectFailure> {
        self.normalize_target(target)
    }
    fn normalize_input(&self, input: &Value) -> Result<Value, EffectFailure> {
        if !input["canon"].is_object() || !input["body"].is_object() {
            return Err(EffectFailure::policy(
                "canon_propose_invalid",
                "Board item is invalid.",
            ));
        }
        Ok(input.clone())
    }
    fn dispatch<'a>(
        &'a self,
        target: &'a str,
        input: &'a Value,
        _: &'a str,
        signal: &'a CancellationToken,
    ) -> EffectFuture<'a, AdapterOutcome> {
        Box::pin(async move {
            self.normalize_target(target)?;
            if signal.is_cancelled() {
                return Ok(AdapterOutcome::NotApplied(adapter(
                    "canon_cancelled",
                    "Board creation cancelled.",
                )));
            }
            let client = ScheduleClient::active(&self.endpoint)
                .map_err(|e| EffectFailure::adapter(e.message()))?;
            let canon = &input["canon"];
            let kind = canon["kind"].as_str().unwrap_or_default();
            let project = canon["project_id"].as_str().unwrap_or_default();
            let result = client
                .request(
                    reqwest::Method::POST,
                    &format!("/projects/{project}/canon/{kind}s"),
                    Some(input["body"].clone()),
                )
                .await;
            match result {
                Ok(row) => {
                    let id = row["id"].as_str().ok_or_else(|| {
                        EffectFailure::adapter("Board create response has no id.")
                    })?;
                    JsonDocument::from_value(&json!({"ok":true,"ref":format!("canon:{kind}/{id}"),
                        "project_id":project,"title":row["title"]}))
                    .map(AdapterOutcome::Applied)
                    .map_err(|e| EffectFailure::adapter(e.to_string()).with_source(e))
                }
                // A transport failure may follow a committed create. Never repeat it blindly.
                Err(e) if e.code() == "schedule_unavailable" => Ok(uncertain()),
                Err(e) => Ok(AdapterOutcome::NotApplied(adapter(e.code(), e.message()))),
            }
        })
    }
    fn reconcile<'a>(
        &'a self,
        _: &'a str,
        _: &'a Value,
        _: &'a str,
        _: &'a CancellationToken,
        attempts: i64,
        _: Option<&'a butler_turn::btcc::EffectError>,
    ) -> EffectFuture<'a, AdapterOutcome> {
        Box::pin(async move {
            if attempts == 0 {
                return Ok(AdapterOutcome::NotApplied(adapter(
                    "not_applied",
                    "Board item was not created.",
                )));
            }
            Ok(uncertain())
        })
    }
}

fn adapter(code: &str, message: &str) -> EffectAdapterError {
    EffectAdapterError::new(code, message)
}
fn uncertain() -> AdapterOutcome {
    AdapterOutcome::Uncertain(Some(adapter(
        "canon_reconciliation_required",
        "Board creation may have applied; inspect the board before creating another item.",
    )))
}
