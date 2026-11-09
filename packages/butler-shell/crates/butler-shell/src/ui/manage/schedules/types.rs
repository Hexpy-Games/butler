//! 예약 작업 data (`app/types.ts:1887-1930` `AutomationSummary`, `AutomationRunSummary`, and the
//! `/automations` answers `stores/automationStore.ts` and `useAutomationsList.ts` read).
#![allow(
    dead_code,
    reason = "seam types: the 예약 작업 units (M1, M2) read them"
)]
use serde::Deserialize;

pub(crate) use crate::ui::source::wire::{AccessMode, CalendarSchedule};

/// `AutomationSummary`
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub(crate) struct AutomationSummary {
    #[serde(default)]
    pub(crate) browser_signin: Option<bool>,
    #[serde(default)]
    pub(crate) browser_payment: Option<bool>,
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) target_label: String,
    pub(crate) state: String,
    #[serde(default)]
    pub(crate) interval_seconds: Option<i64>,
    #[serde(default)]
    pub(crate) schedule_type: Option<String>,
    #[serde(default)]
    pub(crate) schedule: Option<CalendarSchedule>,
    #[serde(default)]
    pub(crate) next_run_at: Option<String>,
    /// The access the schedule's runs get; it never changes the target conversation's mode.
    pub(crate) access_mode: AccessMode,
    /// The schedule's own model; `None` means runs follow the target chat's model.
    #[serde(default)]
    pub(crate) model: Option<String>,
}

/// `AutomationRunSummary`
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub(crate) struct AutomationRunSummary {
    pub(crate) id: String,
    pub(crate) state: String,
    #[serde(default)]
    pub(crate) safe_error_code: Option<String>,
    pub(crate) started_at: String,
    /// The turn the run started, once it started one.
    #[serde(default)]
    pub(crate) turn_id: Option<String>,
}

/// `GET /automations/{id}` `automation`: the summary plus what the form edits.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub(crate) struct AutomationRecord {
    #[serde(flatten)]
    pub(crate) summary: AutomationSummary,
    pub(crate) prompt_body: String,
    pub(crate) target_session_id: String,
    #[serde(default)]
    pub(crate) run_at: Option<String>,
    #[serde(default)]
    pub(crate) start_at: Option<String>,
}

/// `GET /automations/{id}`
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub(crate) struct AutomationDetailView {
    pub(crate) automation: AutomationRecord,
}

/// `GET /automations`
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub(crate) struct AutomationsPage {
    pub(crate) automations: Vec<AutomationSummary>,
}

/// `GET /automations/{id}/runs`
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub(crate) struct AutomationRunsPage {
    #[serde(default)]
    pub(crate) runs: Vec<AutomationRunSummary>,
}
