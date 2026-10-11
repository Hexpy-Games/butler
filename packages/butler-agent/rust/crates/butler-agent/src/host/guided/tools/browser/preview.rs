//! Reviewed dev-server effects through the conversation authority lane.
use super::super::{GuidedTools, dispatch::encoded};
use super::{authority, client::Client};
use butler_core::json::JsonDocument;
use butler_turn::btcc::{
    AccessMode, AdapterOutcome, EffectAccess, EffectAdapter, EffectAdapterError, EffectFailure,
    EffectFuture, EffectOutcome, ExecuteEffect, GuidedInvocation, ModelRoundToolCall, PlanBinding,
    ToolExecutionError,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub(super) async fn execute(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    occurrence: &str,
    client: Client,
) -> Result<JsonDocument, ToolExecutionError> {
    if owner.binding.access_mode == AccessMode::ReadOnly {
        return encoded(&json!({"status":"not_dispatched","reason":"read_only"}));
    }
    let input = match prepare_input(owner, call, occurrence).await {
        Ok(input) => input,
        Err(reason) => return encoded(&json!({"status":"not_dispatched","reason":reason})),
    };
    let target = if call.name == "preview_start" {
        input["cwd"].as_str()
    } else {
        input["preview_id"].as_str()
    }
    .unwrap_or("")
    .to_owned();
    let approval = match authority::gate(owner, call, occurrence, &input, &target).await? {
        authority::Gate::Pending(value) => return encoded(&value),
        authority::Gate::Allowed(reference) => reference,
    };
    let work = owner
        .work
        .bound_work()
        .await
        .map_err(ToolExecutionError::Integrity)?
        .unwrap_or_else(|| super::super::effect::runtime_work::untracked(owner));
    let outcome = owner
        .effects
        .execute(ExecuteEffect {
            work,
            access: EffectAccess::Full,
            occurrence_id: Some(occurrence.into()),
            signal: invocation.cancellation.clone(),
            target,
            input: input.clone(),
            adapter: Arc::new(PreviewAdapter {
                client,
                input,
                name: call.name.clone(),
            }),
        })
        .await
        .map_err(|e| ToolExecutionError::Integrity(e.into()))?;
    let result = match outcome {
        EffectOutcome::Applied { result, .. } => {
            serde_json::from_str(result.as_str()).unwrap_or_else(|_| json!({"status":"unknown"}))
        }
        EffectOutcome::Uncertain { .. } => {
            json!({"status":"unknown","reason":"preview_result_unknown"})
        }
        _ => json!({"status":"not_dispatched","reason":"effect_refused"}),
    };
    super::settle(
        owner,
        approval,
        result["status"].as_str().unwrap_or("unknown"),
    )
    .await?;
    encoded(&result)
}
async fn prepare_input(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    occurrence: &str,
) -> Result<Value, &'static str> {
    let mut input = Value::Object(call.arguments.clone());
    if call.name == "preview_start" {
        let workspace = owner.binding.workspace_path.clone();
        let path = input["cwd"].as_str().unwrap_or(".").to_owned();
        let cwd = tokio::task::spawn_blocking(move || {
            let root = workspace.canonicalize()?;
            let cwd = root.join(path).canonicalize()?;
            if !cwd.is_dir() || !cwd.starts_with(&root) {
                return Err(std::io::Error::other("outside_workspace"));
            }
            Ok(cwd.to_string_lossy().into_owned())
        })
        .await;
        let Ok(Ok(cwd)) = cwd else {
            return Err("invalid_cwd");
        };
        input["cwd"] = json!(cwd);
        input["preview_id"] = json!(format!(
            "p-{:x}",
            Sha256::digest(format!("{}:{occurrence}", owner.binding.source_session_id))
        ));
        if input["command"]
            .as_str()
            .is_none_or(|s| s.trim().is_empty() || s.len() > 8192)
            || input["port"]
                .as_u64()
                .is_none_or(|p| !(1024..=65535).contains(&p))
        {
            return Err("invalid_preview");
        }
    }
    input["agent"] = json!(owner.binding.source_session_id);
    input["always_confirm"] = json!(true);
    Ok(input)
}
struct PreviewAdapter {
    client: Client,
    input: Value,
    name: String,
}
impl EffectAdapter for PreviewAdapter {
    fn capability(&self) -> &'static str {
        if self.name == "preview_start" {
            "preview_start"
        } else {
            "preview_stop"
        }
    }
    fn binding(&self) -> PlanBinding {
        PlanBinding::AcceptedPlan
    }
    fn normalize_target(&self, target: &str) -> Result<String, EffectFailure> {
        Ok(target.into())
    }
    fn sanitize_target(&self, target: &str) -> Result<String, EffectFailure> {
        Ok(target.into())
    }
    fn normalize_input(&self, input: &Value) -> Result<Value, EffectFailure> {
        Ok(input.clone())
    }
    fn dispatch<'a>(
        &'a self,
        _: &'a str,
        _: &'a Value,
        _: &'a str,
        signal: &'a CancellationToken,
    ) -> EffectFuture<'a, AdapterOutcome> {
        Box::pin(async move {
            let result = self
                .client
                .call(
                    if self.name == "preview_start" {
                        "preview.start"
                    } else {
                        "preview.stop"
                    },
                    &Value::Null,
                    &self.input,
                    signal,
                )
                .await;
            JsonDocument::from_value(&result)
                .map(AdapterOutcome::Applied)
                .map_err(|e| EffectFailure::adapter(e.to_string()))
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
            Ok(if attempts == 0 {
                AdapterOutcome::NotApplied(EffectAdapterError::new(
                    "not_dispatched",
                    "No preview dispatched.",
                ))
            } else {
                AdapterOutcome::Uncertain(Some(EffectAdapterError::new(
                    "preview_result_unknown",
                    "Check the preview before starting another server.",
                )))
            })
        })
    }
}
