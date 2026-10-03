//! One startup recovery pass, detached from admission and cancelled by service stop.
use butler_memory::{management::MemoryManagement, profile::ProfileService};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
pub(crate) fn recover_resets(
    owner: Arc<MemoryManagement>,
    profile: Arc<ProfileService>,
    instructions: Arc<butler_memory::cognition::RememberedRuleOwner>,
    stop: CancellationToken,
) {
    tokio::spawn(async move {
        let pending = match owner.pending_resets().await {
            Ok(pending) => pending,
            Err(error) => {
                butler_core::diagnostic!("[memory-reset-recovery] {}", error);
                return;
            }
        };
        for receipt in pending {
            if stop.is_cancelled() {
                break;
            }
            let result = if receipt.kind == "profile" {
                reset_profile(&owner, &profile, receipt.operation_id, stop.child_token()).await
            } else if receipt.kind == "project_memory" {
                owner
                    .reset_project(
                        receipt.operation_id,
                        instructions.clone(),
                        stop.child_token(),
                    )
                    .await
            } else {
                owner
                    .reset_conversations(receipt.operation_id, stop.child_token())
                    .await
            };
            if let Err(error) = result {
                butler_core::diagnostic!("[memory-reset-recovery] {}", error);
            }
        }
    });
}

pub(crate) async fn reset_profile(
    owner: &MemoryManagement,
    profile: &ProfileService,
    id: String,
    token: CancellationToken,
) -> std::io::Result<butler_memory::management::ResetResult> {
    let result = profile
        .reset_profiling_data(id.clone(), token.clone())
        .await;
    let phase = if result.is_ok() {
        "complete"
    } else if token.is_cancelled() {
        "cancelled"
    } else {
        "failed"
    };
    let receipt = owner.complete_profile_reset(id, phase.into()).await?;
    result.map_err(std::io::Error::other)?;
    Ok(receipt)
}
