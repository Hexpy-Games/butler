//! Typed renderer wire contracts; field names follow their TypeScript sources.
use serde::Deserialize;

use crate::ui::source::wire::{SessionControlsView, SessionQueueView};

/// TS: packages/butler-app/client/ui/src/app/types.ts:762 PlanDecisionResultView (`plan_document`
/// is a `ProjectDashboardDocument`; only the fields the plan card reads).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct PlanDecisionDocument {
    pub(crate) id: String,
    pub(crate) title: String,
    #[serde(default)]
    pub(crate) status: Option<String>,
    pub(crate) markdown: String,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:762 PlanDecisionResultView
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct PlanDecisionResultView {
    pub(crate) plan_document: PlanDecisionDocument,
    pub(crate) controls: SessionControlsView,
    #[serde(default)]
    pub(crate) queued: Option<SessionQueueView>,
}
