//! Memory Settings port and change-event bridge. No polling or idle worker.
use crate::gateway::{ApplicationFuture, GatewayApplicationError};
use serde_json::{Map, Value};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

/// Authenticated owner requests, excluding all reset operations.
pub enum AppMemoryCommand {
    /// Cheap cached view.
    Inventory,
    /// Explicit expensive measurement.
    Check,
    /// Explicit cleanup of automatic-memory storage artifacts.
    Cleanup {
        operation_id: String,
        inventory_revision: u64,
    },
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
        self.dependencies
            .memory_management
            .execute(command, sink, cancellation)
            .await
    }
}
