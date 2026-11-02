//! An immutable permission snapshot for each tool-execution boundary.
use super::GuidedTools;
use butler_core::json::JsonDocument;
use butler_turn::btcc::{AccessMode, GuidedInvocation, ModelRoundToolCall, ToolExecutionError};

tokio::task_local! {
    static EXECUTION_ACCESS: AccessMode;
    static APPROVED_CAPABILITY: String;
}

impl GuidedTools {
    pub(super) fn access_mode(&self) -> AccessMode {
        EXECUTION_ACCESS
            .try_with(Clone::clone)
            .unwrap_or_else(|_| self.binding.access_mode.clone())
    }
}

pub(super) async fn execute(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
) -> Result<JsonDocument, ToolExecutionError> {
    owner
        .same_turn(invocation)
        .map_err(ToolExecutionError::Integrity)?;
    if invocation.cancellation.is_cancelled() {
        return Err(ToolExecutionError::Integrity(
            butler_turn::btcc::BtccError::relayed("turn_cancelled", "turn_cancelled"),
        ));
    }
    let mode = owner
        .authority
        .execution_access(owner.binding.turn_id.clone())
        .await
        .map_err(|e| ToolExecutionError::Integrity(e.into()))?
        .unwrap_or_else(|| owner.binding.access_mode.clone());
    let snapshot = super::permission_surface::snapshot(owner, invocation.turn, &mode)
        .await
        .map_err(ToolExecutionError::Integrity)?;
    super::permission_surface::scope(
        snapshot,
        EXECUTION_ACCESS.scope(mode, super::execute::execute(owner, invocation, call)),
    )
    .await
}

pub(super) async fn approved(
    owner: &GuidedTools,
    occurrence: &str,
    capability: &str,
) -> Result<Option<AccessMode>, ToolExecutionError> {
    if !super::access::resumes(owner, occurrence) {
        return Ok(None);
    }
    owner
        .authority
        .approved_execution_access(
            owner
                .binding
                .authority_request_ref
                .clone()
                .unwrap_or_default(),
            owner.binding.turn_id.clone(),
            occurrence.into(),
            capability.into(),
        )
        .await
        .map_err(|e| ToolExecutionError::Integrity(e.into()))
}

pub(super) async fn with_approval<F: std::future::Future>(
    mode: Option<AccessMode>,
    capability: String,
    future: F,
) -> F::Output {
    match mode {
        Some(mode) => {
            APPROVED_CAPABILITY
                .scope(capability, EXECUTION_ACCESS.scope(mode, future))
                .await
        }
        None => future.await,
    }
}

/// Only the stored, allowed occurrence may retain its original tool admission.
pub(super) fn approved_capability(name: &str) -> bool {
    APPROVED_CAPABILITY
        .try_with(|capability| capability == name)
        .unwrap_or(false)
}
