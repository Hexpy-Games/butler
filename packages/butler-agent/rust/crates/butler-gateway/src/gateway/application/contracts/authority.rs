//! Durable authority and pending-ask read ports.
use super::*;

#[derive(Clone, Debug)]
pub struct AppAuthorityPage {
    pub requests: Vec<Value>,
    pub permissions: Vec<Value>,
}

#[derive(Clone, Debug)]
pub struct AppAuthorityDecision {
    pub request_ref: String,
    pub decision: String,
    pub admitted: bool,
    pub question_followup: Option<String>,
}

#[derive(Clone, Debug)]
pub struct AppAuthorityDecisionInput {
    pub owner_session_id: String,
    pub request_ref: String,
    pub action: String,
    pub allow_scope: Option<String>,
    pub alternative_input: Option<String>,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
pub struct AppGrantRef {
    pub grant_ref: String,
    pub session_id: String,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct AppGrantView {
    pub grant_ref: String,
    pub capability: String,
    pub target: String,
    pub cwd: Option<String>,
    pub scope: &'static str,
    pub session_id: String,
    pub workspace_path: String,
    pub created_at: String,
    pub session_title: Option<String>,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
}

pub trait AppAuthorityHandoff: Send + Sync + 'static {
    fn pending_asks(
        &self,
        _owner: Option<String>,
        _limit: usize,
        _before: Option<String>,
    ) -> ApplicationFuture<Vec<butler_turn::btcc::PendingAsk>> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn pending_ask_signal(&self) -> Option<tokio::sync::watch::Receiver<()>> {
        None
    }
    fn pending_ask_changes(
        &self,
        _after: i64,
    ) -> ApplicationFuture<Vec<butler_turn::btcc::PendingAskChange>> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn ack_pending_asks(&self, _through: i64) -> ApplicationFuture<()> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn dismiss_pending_question(
        &self,
        _owner: String,
        _reference: String,
    ) -> ApplicationFuture<bool> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    /// Owners waiting on a decision, each with whether one ask is its own.
    fn attention_sessions(&self, _sessions: Vec<String>) -> ApplicationFuture<Vec<(String, bool)>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    fn session_requests(
        &self,
        owner_session_id: String,
        turns: Vec<String>,
    ) -> ApplicationFuture<(Vec<Value>, Vec<Value>)>;
    fn list_all_permissions(&self) -> ApplicationFuture<Vec<AppGrantView>>;
    fn revoke_permissions(&self, grants: Vec<AppGrantRef>) -> ApplicationFuture<()>;
    fn list(&self, owner_session_id: String) -> ApplicationFuture<AppAuthorityPage>;
    fn revoke(&self, owner_session_id: String, grant_ref: String) -> ApplicationFuture<()>;
    fn decide(&self, input: AppAuthorityDecisionInput) -> ApplicationFuture<AppAuthorityDecision>;
    fn retry_decided(&self) -> ApplicationFuture<Vec<(String, String, String)>>;
    fn settle_question_followup(&self, request_ref: String) -> ApplicationFuture<()>;
    fn delete_session_context(&self, _runtime_session_id: String) -> ApplicationFuture<()> {
        Box::pin(async { Ok(()) })
    }
    fn close_self_session(
        &self,
        runtime_session_id: String,
        reason: String,
    ) -> ApplicationFuture<()>;
}
