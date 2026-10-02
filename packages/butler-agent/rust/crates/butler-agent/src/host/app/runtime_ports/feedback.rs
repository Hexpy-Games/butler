//! Thin owner API over the same daily consolidation and memory services.
use butler_gateway::gateway::{
    AppFeedbackCommand, AppFeedbackPort, ApplicationFuture, GatewayApplicationError,
};
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub(in crate::host) struct AppFeedback {
    pub feedback: Arc<butler_memory::cognition::FeedbackBufferService>,
    pub daily: Arc<crate::host::memory_jobs::daily::DailyCognitionJobs>,
}
impl AppFeedbackPort for AppFeedback {
    fn execute(
        &self,
        command: AppFeedbackCommand,
        cancellation: CancellationToken,
    ) -> ApplicationFuture<Value> {
        let daily = self.daily.clone();
        let feedback = self.feedback.clone();
        Box::pin(async move {
            match command {
                AppFeedbackCommand::EndSession { session_id } => feedback
                    .end_feedback_session(session_id)
                    .await
                    .map(|()| serde_json::json!({"ok":true}))
                    .map_err(GatewayApplicationError::internal_from),
                AppFeedbackCommand::Consolidate { input } => daily
                    .manual_feedback(input, cancellation)
                    .await
                    .map_err(GatewayApplicationError::internal_from),
            }
        })
    }
}

pub(in crate::host) fn port(runtime: &crate::host::AgentRuntime) -> Arc<dyn AppFeedbackPort> {
    Arc::new(AppFeedback {
        daily: runtime.daily_cognition.clone(),
        feedback: runtime.feedback.clone(),
    })
}
