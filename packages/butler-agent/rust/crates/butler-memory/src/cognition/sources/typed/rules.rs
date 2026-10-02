//! Explicit rule owner: inventory, lease-bound journal and request recovery.
mod inventory;
mod transaction;

use super::write::{ExplicitMemoryUpdateInput, explicit_rule_revision, sha256};
use super::{ExplicitRuleBinding, RuleOperation, read_binding};
use crate::cognition::{
    CognitionCode, CognitionError, CognitionPathEnvironment, CognitionResult, CompletionPublisher,
    MemoryGenerationTarget, assert_mutation_authority, ensure_data_authority,
    resolve_active_generation,
};
use crate::coordination::{CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator};
use inventory::Inventory;
pub use inventory::{RememberedRule, list_remembered_rules};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Arc};
use tokio_util::sync::CancellationToken;

/// Exact owner target supplied by a trusted adapter, never by model revisions.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct RememberedRuleTarget {
    /// Stable opaque rule handle.
    pub handle: String,
    /// Revision displayed by the selecting snapshot.
    pub expected_revision: String,
    /// Exact binding authorized by the adapter; None means All chats.
    pub project_id: Option<String>,
}

/// Durable mutation receipt. Recall projection of corrected text is asynchronous.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RememberedRuleReceipt {
    /// Stable handle.
    pub rule: String,
    /// Idempotency key.
    pub operation_id: String,
    /// active or forgotten.
    pub state: String,
    /// This request replayed a completed operation.
    pub replayed: bool,
}

/// Process-owned rule mutation service using the shared consolidation lease.
#[derive(Clone)]
pub struct RememberedRuleOwner {
    data_root: PathBuf,
    environment: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    publisher: Arc<CompletionPublisher>,
}

impl RememberedRuleOwner {
    /// Compose the owner with the existing coordinator and completion queue.
    pub fn new(
        data_root: PathBuf,
        environment: CognitionPathEnvironment,
        coordinator: Arc<CognitionWriteCoordinator>,
        publisher: Arc<CompletionPublisher>,
    ) -> Self {
        Self {
            data_root,
            environment,
            coordinator,
            publisher,
        }
    }

    /// Remember a new rule. Targeted changes are enabled only after exclusion wiring.
    pub async fn remember(
        &self,
        input: ExplicitMemoryUpdateInput,
        cancellation: CancellationToken,
    ) -> CognitionResult<RememberedRuleReceipt> {
        self.run(
            Some(transaction::Request::Remember {
                input,
                target: None,
            }),
            cancellation,
        )
        .await?
        .ok_or_else(|| failure("rule_receipt_missing"))
    }

    /// Correct a selected rule without changing its immutable binding.
    pub async fn correct(
        &self,
        target: RememberedRuleTarget,
        input: ExplicitMemoryUpdateInput,
        cancellation: CancellationToken,
    ) -> CognitionResult<RememberedRuleReceipt> {
        if input.project_id != target.project_id {
            return Err(failure("rule_binding_mismatch"));
        }
        self.run(
            Some(transaction::Request::Remember {
                input,
                target: Some(target),
            }),
            cancellation,
        )
        .await?
        .ok_or_else(|| failure("rule_receipt_missing"))
    }

    /// Delete the selected saved rule only. Chats and archived revisions are kept.
    pub async fn forget(
        &self,
        target: RememberedRuleTarget,
        operation_id: String,
        conversation_session_id: Option<String>,
        conversation_message_id: Option<String>,
        cancellation: CancellationToken,
    ) -> CognitionResult<RememberedRuleReceipt> {
        self.run(
            Some(transaction::Request::Forget {
                target,
                operation_id,
                conversation_session_id,
                conversation_message_id,
            }),
            cancellation,
        )
        .await?
        .ok_or_else(|| failure("rule_receipt_missing"))
    }

    /// Recover only the durable pending operation; no directory or idle scan.
    pub async fn recover(&self, cancellation: CancellationToken) -> CognitionResult<()> {
        // Read-only fast path means a restart with no pending operation takes no lease.
        let pending = self.root().join("pending.json");
        if !tokio::task::spawn_blocking(move || pending.try_exists())
            .await
            .map_err(failure_source)?
            .map_err(failure_source)?
        {
            return Ok(());
        }
        self.run(None, cancellation).await.map(|_| ())
    }

    async fn run(
        &self,
        request: Option<transaction::Request>,
        cancellation: CancellationToken,
    ) -> CognitionResult<Option<RememberedRuleReceipt>> {
        let owner = self.clone();
        tokio::task::spawn_blocking(move || owner.authority())
            .await
            .map_err(failure_source)??;
        let lock = self.environment.consolidation_lock(&self.data_root);
        let lease = self
            .coordinator
            .acquire(
                CognitionWriteAcquire {
                    lock_path: lock.clone(),
                    purpose: Some("remembered_rule".into()),
                    deadline_at_epoch_ms: None,
                    cancellation: Some(cancellation.clone()),
                },
                CognitionWaitClass::Interactive,
            )
            .await
            .map_err(CognitionError::from)?
            .ok_or_else(|| failure("rule_write_cancelled"))?;
        let owner = self.clone();
        tokio::task::spawn_blocking(move || {
            lease.assert_for_path(&lock).map_err(CognitionError::from)?;
            owner.authority()?;
            let result = if cancellation.is_cancelled() {
                Err(failure("rule_write_cancelled"))
            } else {
                transaction::run(&owner, request)
            };
            let released = lease.release(result.is_ok()).map_err(CognitionError::from);
            result.and_then(|value| released.map(|()| value))
        })
        .await
        .map_err(failure_source)?
    }

    fn root(&self) -> PathBuf {
        crate::cognition::explicit_memory_rules_root(&self.environment.memory_root(&self.data_root))
    }

    fn authority(&self) -> CognitionResult<()> {
        let generation = resolve_active_generation(&self.data_root, &self.environment)?;
        assert_mutation_authority(
            &self.data_root,
            &self.environment,
            &MemoryGenerationTarget::Active {
                expected_generation: generation.generation_id.clone(),
            },
            &generation,
        )?;
        ensure_data_authority(
            &self.data_root,
            &[
                &self.root(),
                &self.environment.consolidation_lock(&self.data_root),
            ],
        )
    }
}

fn failure(message: &str) -> CognitionError {
    CognitionError::new(CognitionCode::MemorySourceChanged, message)
}
fn failure_source(source: impl std::error::Error + Send + Sync + 'static) -> CognitionError {
    CognitionError::new(CognitionCode::MemorySourceUnavailable, source.to_string())
        .with_source(source)
}

/// Pending source changes are invisible until files, graph and receipt agree.
pub(super) fn rule_pending(
    memory_root: &std::path::Path,
    record_id: &str,
) -> CognitionResult<bool> {
    let pending: Option<transaction::Intent> = inventory::read_json(
        &crate::cognition::explicit_memory_rules_root(memory_root).join("pending.json"),
    )?;
    Ok(pending.is_some_and(|pending| pending.entry.record_id == record_id))
}
