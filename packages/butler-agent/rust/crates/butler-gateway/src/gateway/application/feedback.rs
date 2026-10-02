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
        match &self.dependencies.feedback {
            Some(port) => port.execute(command, cancellation),
            None => Box::pin(async { Err(crate::gateway::GatewayApplicationError::internal()) }),
        }
    }
}
