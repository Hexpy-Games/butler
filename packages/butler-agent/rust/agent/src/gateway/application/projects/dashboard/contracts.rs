use std::{future::Future, pin::Pin};

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::gateway::{ApplicationFuture, GatewayApplicationError};

pub(crate) type AppProjectDashboardLedgerFuture<T> =
    Pin<Box<dyn Future<Output = Result<T, AppProjectDashboardLedgerError>> + Send + 'static>>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AppProjectDashboardLedgerError {
    Changed,
    Unavailable,
    Internal,
}

#[derive(Clone, Debug)]
pub(crate) struct AppProjectDashboardLedgerRecord {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub status: String,
    pub path: String,
    pub parent_id: Option<String>,
    pub spec: Option<String>,
    pub updated_at: String,
    pub unavailable: bool,
    pub priority: f64,
}

#[derive(Clone, Debug)]
pub(crate) struct AppProjectDashboardActionProgress {
    pub status: String,
}

#[derive(Clone, Debug)]
pub(crate) struct AppProjectDashboardManagedPlan {
    pub id: String,
    pub objective: String,
    pub created_at: String,
}

#[derive(Clone, Debug)]
pub(crate) struct AppProjectDashboardCheckpoint {
    pub created_at: String,
    pub public_summary: Option<String>,
    pub next_step: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct AppProjectDashboardDisposition {
    pub created_at: String,
    pub summary: Option<String>,
    pub remaining_actions: Vec<String>,
    pub followups: Vec<String>,
    pub next_condition: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct AppProjectDashboardReview {
    pub corrections: Vec<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct AppProjectDashboardManagedWork {
    pub objective: String,
    pub status: String,
    pub session_id: String,
    pub current_stage: Option<String>,
    pub action_progress: Vec<AppProjectDashboardActionProgress>,
    pub current_plan: Option<AppProjectDashboardManagedPlan>,
    pub latest_checkpoint: Option<AppProjectDashboardCheckpoint>,
    pub latest_disposition: Option<AppProjectDashboardDisposition>,
    pub latest_result_review: Option<AppProjectDashboardReview>,
    pub latest_plan_review: Option<AppProjectDashboardReview>,
}

#[derive(Clone, Debug)]
pub(crate) struct AppProjectDashboardWork {
    pub record: AppProjectDashboardLedgerRecord,
    pub revision: Option<String>,
    pub availability: String,
    pub managed: Option<AppProjectDashboardManagedWork>,
}

#[derive(Clone, Debug)]
pub(crate) struct AppProjectDashboardSnapshot {
    pub revision: String,
    pub observed_at: String,
    pub records: Vec<AppProjectDashboardLedgerRecord>,
    pub works: Vec<AppProjectDashboardWork>,
}

#[derive(Clone, Debug)]
pub(crate) struct AppProjectDashboardSource {
    pub title: String,
    pub body: String,
    pub revision: String,
    pub document_type: String,
    pub updated_at: String,
    pub status: String,
}

#[derive(Clone, Debug)]
pub(crate) struct AppProjectDashboardLedgerEvent {
    pub id: String,
    pub record_id: String,
    pub kind: String,
    pub action: String,
    pub at: String,
}

#[derive(Clone, Debug)]
pub(crate) struct AppProjectDashboardLedgerHistory {
    pub revision: String,
    pub events: Vec<AppProjectDashboardLedgerEvent>,
}

#[derive(Clone, Debug)]
pub(crate) struct AppProjectDashboardWorkHistoryEntry {
    pub id: String,
    pub work_id: String,
    pub session_id: String,
    pub action: String,
    pub at: String,
    pub title: String,
    pub body: String,
    pub revision: String,
    pub status: String,
}

/// Required read-only boundary to the existing Project Ledger owner.
pub(crate) trait AppProjectDashboardLedgerPort: Send + Sync + 'static {
    fn snapshot(
        &self,
        app_project_id: String,
        ledger_project_id: String,
    ) -> AppProjectDashboardLedgerFuture<AppProjectDashboardSnapshot>;

    fn source(
        &self,
        app_project_id: String,
        ledger_project_id: String,
        kind: String,
        id: String,
        expected_revision: String,
    ) -> AppProjectDashboardLedgerFuture<AppProjectDashboardSource>;

    fn history(
        &self,
        ledger_project_id: String,
    ) -> AppProjectDashboardLedgerFuture<AppProjectDashboardLedgerHistory>;

    fn work_history(
        &self,
        app_project_id: String,
        ledger_project_id: String,
        expected_snapshot_revision: String,
        work_id: Option<String>,
    ) -> AppProjectDashboardLedgerFuture<Vec<AppProjectDashboardWorkHistoryEntry>>;
}

#[cfg(test)]
pub(crate) struct TestProjectDashboardLedger;

#[cfg(test)]
impl AppProjectDashboardLedgerPort for TestProjectDashboardLedger {
    fn snapshot(
        &self,
        _: String,
        _: String,
    ) -> AppProjectDashboardLedgerFuture<AppProjectDashboardSnapshot> {
        Box::pin(async { Err(AppProjectDashboardLedgerError::Unavailable) })
    }

    fn source(
        &self,
        _: String,
        _: String,
        _: String,
        _: String,
        _: String,
    ) -> AppProjectDashboardLedgerFuture<AppProjectDashboardSource> {
        Box::pin(async { Err(AppProjectDashboardLedgerError::Unavailable) })
    }

    fn history(
        &self,
        _: String,
    ) -> AppProjectDashboardLedgerFuture<AppProjectDashboardLedgerHistory> {
        Box::pin(async { Err(AppProjectDashboardLedgerError::Unavailable) })
    }

    fn work_history(
        &self,
        _: String,
        _: String,
        _: String,
        _: Option<String>,
    ) -> AppProjectDashboardLedgerFuture<Vec<AppProjectDashboardWorkHistoryEntry>> {
        Box::pin(async { Err(AppProjectDashboardLedgerError::Unavailable) })
    }
}

#[derive(Clone, Debug)]
pub(crate) struct AppProjectDashboardRecordsQuery {
    pub kind: String,
    pub parent: Option<String>,
    pub cursor: Option<String>,
    pub limit: usize,
    pub lane: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct AppProjectDashboardPageQuery {
    pub cursor: Option<String>,
    pub limit: usize,
    pub all: bool,
    pub important: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct AppProjectDashboardSourceQuery {
    pub kind: String,
    pub id: String,
    pub revision: String,
    pub cursor: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct AppProjectDashboardStatisticsQuery {
    pub period: u8,
    pub timezone: String,
}

#[derive(Clone, Debug)]
pub(crate) struct AppProjectDashboardPinRef {
    pub kind: String,
    pub id: String,
    pub revision: String,
}

#[derive(Clone, Debug)]
pub(crate) struct AppProjectDashboardPreferencesUpdate {
    pub expected_revision: u64,
    pub description: Option<String>,
    pub pinned_source_refs: Option<Vec<AppProjectDashboardPinRef>>,
}

#[derive(Clone, Debug)]
pub(crate) struct AppProjectDashboardBriefingRequest {
    pub source_revision: String,
    pub retry: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct AppProjectDashboardBriefingPrompt {
    pub model: String,
    pub reasoning_effort: String,
    pub instructions: String,
    pub prompt: String,
    pub cache_scope: String,
    pub usage_phase: String,
    pub requested_output_tokens: u64,
}

pub(crate) trait AppProjectDashboardBriefingPort: Send + Sync + 'static {
    fn estimate_tokens(&self, model_ref: String, text: String) -> ApplicationFuture<f64>;

    fn generate(
        &self,
        prompt: AppProjectDashboardBriefingPrompt,
        cancellation: CancellationToken,
    ) -> ApplicationFuture<String>;
}

#[cfg(test)]
pub(crate) struct TestProjectDashboardBriefing;

#[cfg(test)]
impl AppProjectDashboardBriefingPort for TestProjectDashboardBriefing {
    fn estimate_tokens(&self, _: String, text: String) -> ApplicationFuture<f64> {
        Box::pin(async move { Ok((text.encode_utf16().count() as f64 / 4.0).ceil()) })
    }

    fn generate(
        &self,
        _: AppProjectDashboardBriefingPrompt,
        _: CancellationToken,
    ) -> ApplicationFuture<String> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
}

pub(crate) fn project_not_found() -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 404,
        code: "project_not_found".into(),
        message: "Project not found.".into(),
    }
}

pub(crate) fn invalid_cursor() -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 400,
        code: "invalid_cursor".into(),
        message: "Invalid cursor.".into(),
    }
}

pub(crate) fn source_changed(message: &'static str) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 409,
        code: "source_changed".into(),
        message: message.into(),
    }
}

pub(crate) fn preferences_changed() -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 409,
        code: "preferences_changed".into(),
        message: "Preferences changed. Reload them.".into(),
    }
}

pub(crate) fn invalid_request() -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 400,
        code: "invalid_request".into(),
        message: "Invalid project dashboard request.".into(),
    }
}

pub(crate) fn unavailable(reason: &'static str) -> Value {
    serde_json::json!({ "status": "unavailable", "reason": reason })
}
