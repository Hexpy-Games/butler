//! Memory Settings port and change-event bridge. No polling or idle worker.
use crate::gateway::{ApplicationFuture, GatewayApplicationError};
use serde_json::{Map, Value};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

/// Authenticated memory owner requests.
pub enum AppMemoryCommand {
    /// Read current consolidation and its latest result.
    Consolidation,
    /// Run the shared consolidation cycle now.
    RunConsolidation { operation_id: String },
    /// Ends session-scoped instructions immediately.
    EndSession { session_id: String },
    /// Complete instruction list from the instruction owner.
    Instructions,
    /// Active recurring pattern notes.
    Patterns,
    /// Pending proposal bundles.
    PatternProposals,
    /// Delete a pattern at the revision the user saw.
    DeletePattern { id: String, expected_revision: u64 },
    /// Decide one candidate; S3 records the choice only.
    DecidePattern {
        bundle_id: String,
        pattern_id: String,
        decision: String,
        expected_revision: u64,
    },
    /// A lasting all-chats instruction added outside a chat (an import).
    RememberInstruction { text: String, operation_id: String },
    /// User-selected deletion, independent of a chat turn.
    DeleteInstruction {
        handle: String,
        expected_revision: String,
        project_id: Option<String>,
        operation_id: String,
    },
    /// Targeted project read.
    Project { project_id: String },
    /// Cheap cached view.
    Inventory,
    /// Explicit expensive measurement.
    Check,
    /// Explicit cleanup of automatic-memory storage artifacts.
    Cleanup {
        operation_id: String,
        inventory_revision: u64,
    },
    /// Reset conversation memory while preserving other kinds.
    ResetChat {
        operation_id: String,
        inventory_revision: u64,
    },
    /// Reset one project's summary, conversation projection and bound instructions.
    ResetProject {
        operation_id: String,
        inventory_revision: u64,
        project_id: String,
    },
    /// Reset profile content while preserving consent and settings.
    ResetProfile {
        operation_id: String,
        inventory_revision: u64,
    },
    /// Durable reset receipt for reconnect.
    ResetStatus { operation_id: String },
    /// Initial/reconnect receipt read.
    Status { operation_id: String },
    /// Cancel reclamation; already reclaimed bytes remain reclaimed.
    Cancel { operation_id: String },
}

/// Persists one operation update through the existing App change-event transport.
pub type MemoryEventSink = Arc<dyn Fn(Value) -> ApplicationFuture<()> + Send + Sync>;

/// Native memory owner adapter.
pub trait AppMemoryPort: Send + Sync + 'static {
    /// New bundle publication only; absent when the adapter has no proposals.
    fn proposals_changed(&self) -> Option<Arc<tokio::sync::Notify>> {
        None
    }
    /// Executes a request. Start returns immediately; events carry progress/result.
    fn execute(
        &self,
        command: AppMemoryCommand,
        events: MemoryEventSink,
        cancellation: CancellationToken,
    ) -> ApplicationFuture<Value>;
}

impl super::AppApplication {
    pub(super) async fn memory_owned(
        &self,
        command: AppMemoryCommand,
        cancellation: CancellationToken,
    ) -> Result<Value, GatewayApplicationError> {
        if let AppMemoryCommand::DecidePattern {
            bundle_id,
            pattern_id,
            decision,
            expected_revision,
        } = command
        {
            return self
                .decide_proposal(
                    bundle_id,
                    pattern_id,
                    decision,
                    expected_revision,
                    cancellation,
                )
                .await;
        }
        let command = self.canonical_project_command(command).await?;
        let listing = matches!(&command, AppMemoryCommand::Instructions);
        let proposals = matches!(&command, AppMemoryCommand::PatternProposals);
        let sink = self.memory_event_sink();
        let mut view = self
            .dependencies
            .memory_management
            .execute(command, sink, cancellation)
            .await?;
        if proposals {
            super::initiated::public_proposals(&mut view);
        }
        if listing {
            view = self.storage.execute(move |db| {
                if let Some(rows) = view["instructions"].as_array_mut() {
                    for row in rows {
                        let project = row["project_id"].as_str();
                        let name: Option<String> = if let Some(id) = project {
                            use rusqlite::OptionalExtension;
                            db.query_row("SELECT display_name FROM projects WHERE id=?1 OR ledger_project_id=?1 LIMIT 1", [id], |r| r.get(0)).optional().map_err(super::AppStorageError::sqlite)?
                        } else { None };
                        row["scope"] = if row["scope_session_id"].is_string() { serde_json::json!({"kind":"session"}) } else if project.is_some() { serde_json::json!({"kind":"project", "project_name":name}) } else { serde_json::json!({"kind":"all"}) };
                    }
                }
                Ok(view)
            }).await.map_err(super::app_error)?;
        }
        Ok(view)
    }
    /// Event bridge shared by explicit memory actions and host-owned scheduled runs.
    pub fn memory_event_sink(&self) -> MemoryEventSink {
        let this = self.clone_handle();
        Arc::new(move |value| {
            let storage = this.storage.clone();
            let subscribers = this.subscribers.clone();
            let now = this.dependencies.identity_clock.now_iso();
            Box::pin(async move {
                let payload: Map<String, Value> = value
                    .as_object()
                    .cloned()
                    .ok_or_else(GatewayApplicationError::internal)?;
                storage
                    .execute(move |db| {
                        super::events::append(
                            db,
                            &subscribers,
                            "memory.operation",
                            None,
                            payload,
                            &now,
                        )
                        .map(|_| ())
                    })
                    .await
                    .map_err(super::app_error)
            })
        })
    }
    async fn canonical_project_command(
        &self,
        mut command: AppMemoryCommand,
    ) -> Result<AppMemoryCommand, GatewayApplicationError> {
        if let AppMemoryCommand::Project { project_id }
        | AppMemoryCommand::ResetProject { project_id, .. } = &command
        {
            let id = project_id.clone();
            let canonical = self
                .storage
                .execute(move |db| {
                    use rusqlite::OptionalExtension;
                    db.query_row(
                        "SELECT COALESCE(ledger_project_id,id) FROM projects WHERE id=?1",
                        [id],
                        |r| r.get::<_, String>(0),
                    )
                    .optional()
                    .map_err(super::AppStorageError::sqlite)
                })
                .await
                .map_err(super::app_error)?
                .ok_or_else(|| super::public(404, "project_not_found", "Project not found."))?;
            if let AppMemoryCommand::Project { project_id }
            | AppMemoryCommand::ResetProject { project_id, .. } = &mut command
            {
                *project_id = canonical;
            }
        }
        Ok(command)
    }
}
