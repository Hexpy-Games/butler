use std::{future::Future, pin::Pin};

use serde::Serialize;

use crate::gateway::SessionQueueView;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AppPlanDecisionAction {
    Accept,
    Reject,
    Instruct,
}

#[derive(Clone, Debug)]
pub struct AppPlanDecisionRequest {
    pub action: AppPlanDecisionAction,
    pub instruction: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AppPlanDecisionStatus {
    Active,
    Rejected,
}

impl AppPlanDecisionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Rejected => "rejected",
        }
    }
}

#[derive(Clone, Debug)]
pub struct AppPlanDecisionPlan {
    pub id: String,
    pub title: String,
    pub status: String,
    pub body: String,
}

/// Failures of the Project Ledger port behind plan decisions.
#[derive(Clone, Debug, thiserror::Error)]
pub enum AppPlanDecisionLedgerError {
    /// The ledger changed during the read; the client may retry.
    #[error("project_ledger_changed")]
    Changed,
    /// The ledger is unavailable (missing or unreadable inputs).
    #[error("project_ledger_unavailable")]
    Unavailable {
        #[source]
        source: Option<std::sync::Arc<dyn std::error::Error + Send + Sync>>,
    },
    /// The ledger read failed unexpectedly.
    #[error("project_ledger_internal")]
    Internal {
        #[source]
        source: Option<std::sync::Arc<dyn std::error::Error + Send + Sync>>,
    },
}

impl AppPlanDecisionLedgerError {
    pub fn unavailable() -> Self {
        Self::Unavailable { source: None }
    }

    pub fn internal() -> Self {
        Self::Internal { source: None }
    }

    /// Records the ledger error behind an unavailable or internal failure.
    #[must_use]
    pub fn with_source(self, cause: impl std::error::Error + Send + Sync + 'static) -> Self {
        match self {
            Self::Unavailable { source: None } => Self::Unavailable {
                source: Some(std::sync::Arc::new(cause)),
            },
            Self::Internal { source: None } => Self::Internal {
                source: Some(std::sync::Arc::new(cause)),
            },
            other => other,
        }
    }
}

pub type AppPlanDecisionLedgerFuture<T> =
    Pin<Box<dyn Future<Output = Result<T, AppPlanDecisionLedgerError>> + Send + 'static>>;

/// Neutral Application boundary to the canonical Project Ledger owner.
pub trait AppPlanDecisionLedgerPort: Send + Sync + 'static {
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
pub struct AppPlanDecisionDocument {
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
pub struct AppPlanDecisionResult {
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
        Box::pin(async { Err(AppPlanDecisionLedgerError::internal()) })
    }

    fn update_plan_status(
        &self,
        _: String,
        _: String,
        _: String,
        _: AppPlanDecisionStatus,
    ) -> AppPlanDecisionLedgerFuture<()> {
        Box::pin(async { Err(AppPlanDecisionLedgerError::internal()) })
    }
}
