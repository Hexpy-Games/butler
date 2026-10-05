//! Memory Settings port and change-event bridge. No polling or idle worker.
use crate::gateway::{ApplicationFuture, GatewayApplicationError};
use serde_json::{Map, Value};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

/// Authenticated memory owner requests.
pub enum AppMemoryCommand {
    /// Ends session-scoped instructions immediately.
    EndSession { session_id: String },
    /// Complete instruction list from the instruction owner.
    Instructions,
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
        let command = self.canonical_project_command(command).await?;
        let listing = matches!(&command, AppMemoryCommand::Instructions);
        let this = self.clone_handle();
        let sink: MemoryEventSink = Arc::new(move |value| {
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
        });
        let mut view = self
            .dependencies
            .memory_management
            .execute(command, sink, cancellation)
            .await?;
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
