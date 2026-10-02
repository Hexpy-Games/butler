use butler_gateway::gateway::{
    AppIdentityClock, AppMemoryCommand, AppMemoryPort, ApplicationFuture, GatewayApplicationError,
    MemoryEventSink,
};
use butler_memory::{
    cognition::{RememberedRuleOwner, RememberedRuleTarget},
    management::MemoryManagement,
};
mod actions;
mod instructions;
mod resets;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub(crate) struct AppMemoryManagement {
    owner: Arc<MemoryManagement>,
    instructions: Arc<RememberedRuleOwner>,
    profile: Arc<butler_memory::profile::ProfileService>,
    shutdown: CancellationToken,
    clock: Arc<dyn AppIdentityClock>,
    jobs: Arc<Mutex<HashMap<String, CancellationToken>>>,
    instruction_count: Arc<Mutex<Option<(u64, u64)>>>,
}

impl AppMemoryManagement {
    pub(crate) fn new(
        owner: Arc<MemoryManagement>,
        instructions: Arc<RememberedRuleOwner>,
        profile: Arc<butler_memory::profile::ProfileService>,
        shutdown: CancellationToken,
        clock: Arc<dyn AppIdentityClock>,
    ) -> Self {
        Self {
            owner,
            instructions,
            profile,
            shutdown,
            clock,
            jobs: Arc::new(Mutex::new(HashMap::new())),
            instruction_count: Arc::new(Mutex::new(None)),
        }
    }

    pub(crate) fn for_runtime(
        runtime: &crate::host::runtime::AgentRuntime,
        clock: Arc<dyn AppIdentityClock>,
    ) -> Self {
        Self::new(
            runtime.memory_management.clone(),
            runtime.memory_writes.clone(),
            runtime.profile.clone(),
            runtime.service_shutdown.clone(),
            clock,
        )
    }

    async fn execute_inner(
        self,
        command: AppMemoryCommand,
        sink: MemoryEventSink,
        cancellation: CancellationToken,
    ) -> Result<Value, GatewayApplicationError> {
        match command {
            AppMemoryCommand::Instructions => self.list_instructions().await,
            AppMemoryCommand::DeleteInstruction {
                handle,
                expected_revision,
                project_id,
                operation_id,
            } => {
                self.delete_instruction(
                    handle,
                    expected_revision,
                    project_id,
                    operation_id,
                    sink,
                    cancellation,
                )
                .await
            }
            AppMemoryCommand::Project { project_id } => {
                self.project(project_id, cancellation).await
            }
            command @ (AppMemoryCommand::ResetChat { .. }
            | AppMemoryCommand::ResetProfile { .. }
            | AppMemoryCommand::ResetProject { .. }
            | AppMemoryCommand::ResetStatus { .. }) => self.reset_command(command, sink).await,
            AppMemoryCommand::Inventory => self.inventory(self.owner.inventory(), false).await,
            AppMemoryCommand::Check => {
                self.inventory(
                    self.owner
                        .refresh(self.clock.now_iso(), cancellation)
                        .await
                        .map_err(error)?,
                    true,
                )
                .await
            }
            AppMemoryCommand::Status { operation_id } => encode(
                self.owner
                    .cleanup_status(operation_id)
                    .await
                    .map_err(error)?
                    .ok_or_else(|| {
                        public_error(404, "memory_operation_not_found", "Operation not found.")
                    })?,
            ),
            AppMemoryCommand::Cancel { operation_id } => {
                let jobs = self
                    .jobs
                    .lock()
                    .map_err(|_| GatewayApplicationError::internal())?;
                if let Some(token) = jobs.get(&operation_id) {
                    token.cancel();
                }
                Ok(json!({"operation_id":operation_id,"cancellation_requested":true}))
            }
            AppMemoryCommand::Cleanup {
                operation_id,
                inventory_revision,
            } => {
                self.start_cleanup(operation_id, inventory_revision, sink)
                    .await
            }
        }
    }

    async fn drive(
        self,
        id: String,
        revision: u64,
        token: CancellationToken,
        sink: MemoryEventSink,
    ) {
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let publish = Arc::new(move |result| {
            let _ = sender.send(result);
        });
        let owner = self.owner.clone();
        let operation_id = id.clone();
        let mut worker =
            tokio::spawn(
                async move { owner.cleanup(operation_id, revision, token, publish).await },
            );
        loop {
            tokio::select! {
                value = receiver.recv() => {
                    if let Some(result) = value {
                        if let Ok(value) = serde_json::to_value(result) { let _ = sink(value).await; }
                    } else { break; }
                }
                result = &mut worker => {
                    // Drain the final durable transition before detaching the operation.
                    while let Ok(result) = receiver.try_recv() {
                        if let Ok(value) = serde_json::to_value(result) { let _ = sink(value).await; }
                    }
                    if let Ok(Err(_)) = result
                        && let Ok(Some(receipt)) = self.owner.cleanup_status(id.clone()).await
                        && let Ok(value) = serde_json::to_value(receipt) {
                        let _ = sink(value).await;
                    }
                    break;
                }
            }
        }
        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.remove(&id);
        }
    }
}

impl AppMemoryPort for AppMemoryManagement {
    fn execute(
        &self,
        command: AppMemoryCommand,
        events: MemoryEventSink,
        cancellation: CancellationToken,
    ) -> ApplicationFuture<Value> {
        Box::pin(self.clone().execute_inner(command, events, cancellation))
    }
}

fn encode(value: impl serde::Serialize) -> Result<Value, GatewayApplicationError> {
    serde_json::to_value(value).map_err(GatewayApplicationError::internal_from)
}

fn error(source: std::io::Error) -> GatewayApplicationError {
    public_error(
        409,
        "memory_operation_unavailable",
        "Memory operation unavailable.",
    )
    .with_source(source)
}

fn public_error(status: u16, code: &str, message: &str) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status,
        code: code.into(),
        message: message.into(),
        source: None,
    }
}
