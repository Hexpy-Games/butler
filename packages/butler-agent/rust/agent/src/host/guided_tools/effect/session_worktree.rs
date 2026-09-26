//! Reviewed session worktree effect over the existing session-owned Git owner.

use std::sync::Arc;

use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use crate::btcc::{
    AdapterOutcome, BtccError, EffectAdapter, EffectAdapterError, EffectFailure, EffectFuture,
    PlanBinding,
};
use crate::json::JsonDocument;
use crate::workspace::{
    BindSessionWorktreeInput, BindSessionWorktreeResult, NativeSessionWorktrees,
    SessionWorktreeAction, WorkspaceReference,
};

use super::super::NativeGuidedTools;

pub(super) fn supports(name: &str) -> bool {
    name == "bind_session_git_worktree"
}

pub(super) fn prepare(
    owner: &NativeGuidedTools,
    args: &Map<String, Value>,
) -> Result<(String, Value, Arc<dyn EffectAdapter>), BtccError> {
    let input = normalize(&Value::Object(args.clone())).map_err(crate::btcc::BtccError::from)?;
    let (Some(action), Some(branch)) = (
        input.get("action").and_then(Value::as_str),
        input.get("branch").and_then(Value::as_str),
    ) else {
        return Err(BtccError::relayed(
            "invalid_arguments",
            "Session worktree input requires action and branch.",
        ));
    };
    let target = format!("session-worktree/{action}/{branch}");
    let reference = owner.binding.workspace_reference.clone().ok_or_else(|| {
        BtccError::relayed(
            "session_workspace_unavailable",
            "Session workspace unavailable",
        )
    })?;
    Ok((
        target.clone(),
        input,
        Arc::new(SessionWorktreeEffect {
            worktrees: owner.session_worktrees.clone(),
            session_id: owner.binding.source_session_id.clone(),
            reference,
            target,
        }),
    ))
}

struct SessionWorktreeEffect {
    worktrees: NativeSessionWorktrees,
    session_id: String,
    reference: WorkspaceReference,
    target: String,
}

impl SessionWorktreeEffect {
    async fn run(&self, input: &Value, signal: &CancellationToken) -> AdapterOutcome {
        let action = match input["action"].as_str() {
            Some("create") => SessionWorktreeAction::Create,
            Some("select") => SessionWorktreeAction::Select,
            _ => return AdapterOutcome::NotApplied(adapter("invalid_action")),
        };
        let result = self
            .worktrees
            .bind(BindSessionWorktreeInput {
                action,
                branch: input["branch"].as_str().unwrap_or_default().into(),
                start_point: input["start_point"].as_str().map(str::to_owned),
                session_id: self.session_id.clone(),
                project_name: None,
                workspace_reference: self.reference.clone(),
                abort: signal.clone(),
            })
            .await;
        match result {
            Ok(BindSessionWorktreeResult::Bound {
                action,
                workspace_label,
                branch,
                dirty,
                source_dirty,
                idempotent,
            }) => {
                let value = json!({
                    "ok":true,"action":action_name(action),"bound":true,
                    "workspace_label":workspace_label,"branch":branch,"dirty":dirty,
                    "source_dirty":source_dirty,"idempotent":idempotent,
                });
                match JsonDocument::from_value(&value) {
                    Ok(value) => AdapterOutcome::Applied(value),
                    Err(_) => {
                        AdapterOutcome::Uncertain(Some(adapter("session_workspace_result_invalid")))
                    }
                }
            }
            Ok(BindSessionWorktreeResult::Failed { code, .. }) => {
                AdapterOutcome::NotApplied(adapter(code))
            }
            Err(error) => AdapterOutcome::Uncertain(Some(EffectAdapterError::new(
                error.code(),
                "The session worktree outcome may be uncertain; inspect the canonical session workspace.",
            ))),
        }
    }
}

impl EffectAdapter for SessionWorktreeEffect {
    fn capability(&self) -> &'static str {
        "bind_session_git_worktree"
    }

    fn binding(&self) -> PlanBinding {
        PlanBinding::AcceptedPlan
    }

    fn normalize_target(&self, target: &str) -> Result<String, EffectFailure> {
        (target == self.target)
            .then(|| target.to_owned())
            .ok_or_else(|| policy("session_workspace_target_changed"))
    }

    fn sanitize_target(&self, target: &str) -> Result<String, EffectFailure> {
        self.normalize_target(target)
    }

    fn normalize_input(&self, input: &Value) -> Result<Value, EffectFailure> {
        let normalized = normalize(input)?;
        let target = format!(
            "session-worktree/{}/{}",
            normalized["action"].as_str().unwrap_or_default(),
            normalized["branch"].as_str().unwrap_or_default(),
        );
        (target == self.target)
            .then_some(normalized)
            .ok_or_else(|| policy("session_workspace_input_changed"))
    }

    fn dispatch<'a>(
        &'a self,
        target: &'a str,
        input: &'a Value,
        _: &'a str,
        signal: &'a CancellationToken,
    ) -> EffectFuture<'a, AdapterOutcome> {
        Box::pin(async move {
            if target != self.target {
                return Ok(AdapterOutcome::NotApplied(adapter(
                    "session_workspace_target_changed",
                )));
            }
            Ok(self.run(input, signal).await)
        })
    }

    fn reconcile<'a>(
        &'a self,
        target: &'a str,
        input: &'a Value,
        _: &'a str,
        signal: &'a CancellationToken,
        attempts: i64,
        _: Option<&'a crate::btcc::EffectError>,
    ) -> EffectFuture<'a, AdapterOutcome> {
        Box::pin(async move {
            if attempts == 0 {
                return Ok(AdapterOutcome::NotApplied(adapter("not_applied")));
            }
            if target != self.target {
                return Ok(AdapterOutcome::Uncertain(Some(adapter(
                    "session_workspace_target_changed",
                ))));
            }
            Ok(self.run(input, signal).await)
        })
    }
}

fn normalize(input: &Value) -> Result<Value, EffectFailure> {
    let args = input
        .as_object()
        .ok_or_else(|| policy("session_workspace_input_invalid"))?;
    let action = args
        .get("action")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "create" | "select"))
        .ok_or_else(|| policy("invalid_action"))?;
    let branch = args
        .get("branch")
        .and_then(Value::as_str)
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| policy("invalid_branch"))?;
    let start_point = args
        .get("start_point")
        .map(|value| {
            value
                .as_str()
                .map(crate::public_text::trim_js_whitespace)
                .ok_or_else(|| policy("invalid_start_point"))
        })
        .transpose()?;
    if action == "select" && start_point.is_some() {
        return Err(policy("invalid_start_point"));
    }
    Ok(match start_point {
        Some(start_point) => json!({"action":action,"branch":branch,"start_point":start_point}),
        None => json!({"action":action,"branch":branch}),
    })
}

fn action_name(action: SessionWorktreeAction) -> &'static str {
    match action {
        SessionWorktreeAction::Create => "create",
        SessionWorktreeAction::Select => "select",
    }
}

fn policy(code: &str) -> EffectFailure {
    EffectFailure::policy(code.to_owned(), "Session workspace input is invalid")
}

fn adapter(code: &str) -> EffectAdapterError {
    EffectAdapterError::new(code, "The session worktree operation was not applied")
}
