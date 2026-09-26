use std::{future::Future, pin::Pin};

use serde::Serialize;

use crate::gateway::SessionQueueView;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AppPlanDecisionAction {
    Accept,
    Reject,
    Instruct,
}

#[derive(Clone, Debug)]
pub(crate) struct AppPlanDecisionRequest {
    pub action: AppPlanDecisionAction,
    pub instruction: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AppPlanDecisionStatus {
    Active,
    Rejected,
}

impl AppPlanDecisionStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Rejected => "rejected",
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct AppPlanDecisionPlan {
    pub id: String,
    pub title: String,
    pub status: String,
    pub body: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AppPlanDecisionLedgerError {
    Changed,
    Unavailable,
    Internal,
}

pub(crate) type AppPlanDecisionLedgerFuture<T> =
    Pin<Box<dyn Future<Output = Result<T, AppPlanDecisionLedgerError>> + Send + 'static>>;

/// Neutral Application boundary to the canonical Project Ledger owner.
pub(crate) trait AppPlanDecisionLedgerPort: Send + Sync + 'static {
    fn read_plan(
        &self,
        app_project_id: String,
        ledger_project_id: String,
        plan_id: String,
    ) -> AppPlanDecisionLedgerFuture<Option<AppPlanDecisionPlan>>;

    fn update_plan_status(
        &self,
        app_project_id: String,
        ledger_project_id: String,
        plan_id: String,
        status: AppPlanDecisionStatus,
    ) -> AppPlanDecisionLedgerFuture<()>;
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct AppPlanDecisionDocument {
    pub id: String,
    pub kind: &'static str,
    pub document_type: &'static str,
    pub title: String,
    pub status: String,
    pub safe_path_label: String,
    pub markdown: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct AppPlanDecisionResult {
    pub plan_document: AppPlanDecisionDocument,
    pub controls: super::super::AppSessionControlsView,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queued: Option<SessionQueueView>,
}

#[cfg(test)]
pub(crate) struct TestAppPlanDecisionLedger;

#[cfg(test)]
impl AppPlanDecisionLedgerPort for TestAppPlanDecisionLedger {
    fn read_plan(
        &self,
        _: String,
        _: String,
        _: String,
    ) -> AppPlanDecisionLedgerFuture<Option<AppPlanDecisionPlan>> {
        Box::pin(async { Err(AppPlanDecisionLedgerError::Internal) })
    }

    fn update_plan_status(
        &self,
        _: String,
        _: String,
        _: String,
        _: AppPlanDecisionStatus,
    ) -> AppPlanDecisionLedgerFuture<()> {
        Box::pin(async { Err(AppPlanDecisionLedgerError::Internal) })
    }
}
