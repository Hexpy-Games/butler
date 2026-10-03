//! Owner cognition API. No settings UI is coupled to this port.
use crate::gateway::ApplicationFuture;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

pub enum AppFeedbackCommand {
    Consolidate { input: Value },
    List,
    Edit { id: String, text: String },
    Delete { id: String },
    SetEnabled { enabled: bool },
    Reset,
    EndSession { session_id: String },
}

pub trait AppFeedbackPort: Send + Sync + 'static {
    fn execute(
        &self,
        command: AppFeedbackCommand,
        cancellation: CancellationToken,
    ) -> ApplicationFuture<Value>;
}

/// Feedback operations exposed to authenticated owner transports.
pub trait GatewayFeedback: Send + Sync {
    fn feedback(
        &self,
        _command: AppFeedbackCommand,
        _cancellation: CancellationToken,
    ) -> ApplicationFuture<Value> {
        Box::pin(async { Err(crate::gateway::GatewayApplicationError::internal()) })
    }
}
impl GatewayFeedback for super::AppApplication {
    fn feedback(
        &self,
        command: AppFeedbackCommand,
        cancellation: CancellationToken,
    ) -> ApplicationFuture<Value> {
        let changed = !matches!(command, AppFeedbackCommand::List);
        let this = self.clone_handle();
        let result = match &self.dependencies.feedback {
            Some(port) => port.execute(command, cancellation),
            None => Box::pin(async { Err(crate::gateway::GatewayApplicationError::internal()) }),
        };
        Box::pin(async move {
            let mut value = result.await?;
            if !changed {
                value = this.storage.execute(move |db| {
                    use rusqlite::OptionalExtension;
                    if let Some(entries) = value["entries"].as_array_mut() {
                        for entry in entries {
                            if let Some(id) = entry["scope"].as_str().and_then(|scope| scope.strip_prefix("project:")) {
                                let name: Option<String> = db.query_row(
                                    "SELECT display_name FROM projects WHERE id=?1 OR ledger_project_id=?1 LIMIT 1",
                                    [id], |row| row.get(0),
                                ).optional().map_err(super::AppStorageError::sqlite)?;
                                entry["project_name"] = serde_json::json!(name);
                            }
                        }
                    }
                    Ok(value)
                }).await.map_err(super::app_error)?;
            }
            if changed {
                let now = this.dependencies.identity_clock.now_iso();
                let subscribers = this.subscribers.clone();
                this.storage
                    .execute(move |db| {
                        super::events::append(
                            db,
                            &subscribers,
                            "memory.operation",
                            None,
                            serde_json::Map::from_iter([(
                                "kind".into(),
                                serde_json::json!("recent_feedback"),
                            )]),
                            &now,
                        )
                        .map(|_| ())
                    })
                    .await
                    .map_err(super::app_error)?;
            }
            Ok(value)
        })
    }
}
