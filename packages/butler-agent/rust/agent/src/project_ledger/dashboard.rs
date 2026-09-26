//! Canonical read-only Project Ledger dashboard sources for App admission.

mod binding;
mod exact;
mod history;
mod ledger_history;
mod managed;
mod snapshot;

use std::path::Path;

use super::ProjectLedgerReadError;
use crate::locale::LocaleCollation;

pub(crate) use ledger_history::DashboardLedgerHistory;
pub(super) use managed::{decode_child_body, decode_manifest_body};

pub(in crate::project_ledger) fn validate_managed_work(
    root: &Path,
    scope: &crate::btcc::ResolvedProjectWorkScope,
    work_id: &str,
    collation: &LocaleCollation,
) -> Result<(), ProjectLedgerReadError> {
    let relative = format!(
        "project-ledger/projects/{}/work/{work_id}/work.md",
        scope.ledger_project_id
    );
    let record = DashboardLedgerRecord {
        id: work_id.into(),
        kind: "work".into(),
        title: String::new(),
        status: String::new(),
        path: relative,
        parent_id: None,
        spec: Some(managed::PROJECT_WORK_SPEC.into()),
        updated_at: String::new(),
        priority: 100.0,
        unavailable: false,
    };
    let exact = exact::read_record(root, &scope.ledger_project_id, &record)?;
    let binding = ProjectLedgerBinding {
        app_project_id: scope.app_project_id.clone(),
        ledger_project_id: scope.ledger_project_id.clone(),
    };
    managed::read_current(root, &binding, &record, &exact, collation)?;
    Ok(())
}

#[derive(Clone, Debug)]
pub(crate) struct ProjectLedgerBinding {
    pub app_project_id: String,
    pub ledger_project_id: String,
}

#[derive(Clone, Debug)]
pub(crate) struct DashboardLedgerRecord {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub status: String,
    pub path: String,
    pub parent_id: Option<String>,
    pub spec: Option<String>,
    pub updated_at: String,
    pub priority: f64,
    pub unavailable: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct DashboardLedgerWork {
    pub record: DashboardLedgerRecord,
    pub revision: Option<String>,
    pub availability: &'static str,
    pub managed: Option<DashboardManagedWorkView>,
}

#[derive(Clone, Debug)]
pub(crate) struct DashboardLedgerSnapshot {
    pub revision: String,
    pub observed_at: String,
    pub records: Vec<DashboardLedgerRecord>,
    pub works: Vec<DashboardLedgerWork>,
}

#[derive(Clone, Debug)]
pub(crate) struct DashboardManagedWorkView {
    pub objective: String,
    pub session_id: String,
    pub status: String,
    pub current_stage: Option<String>,
    pub action_progress: Vec<DashboardActionProgress>,
    pub current_plan: Option<DashboardManagedPlanView>,
    pub latest_checkpoint: Option<DashboardCheckpointSummary>,
    pub latest_disposition: Option<DashboardDispositionSummary>,
    pub latest_plan_review_corrections: Vec<String>,
    pub latest_result_review_corrections: Vec<String>,
    pub public_summary: Option<String>,
    pub remaining_actions: Vec<String>,
    pub followups: Vec<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct DashboardActionProgress {
    pub status: String,
}

#[derive(Clone, Debug)]
pub(crate) struct DashboardManagedPlanView {
    pub id: String,
    pub objective: String,
    pub created_at: String,
    pub actions: Vec<String>,
    pub checks: Vec<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct DashboardCheckpointSummary {
    pub created_at: String,
    pub public_summary: String,
    pub next_step: String,
}

#[derive(Clone, Debug)]
pub(crate) struct DashboardDispositionSummary {
    pub created_at: String,
    pub summary: String,
    pub next_condition: Option<String>,
    pub remaining_actions: Vec<String>,
    pub followups: Vec<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct DashboardLedgerSource {
    pub title: String,
    pub body: String,
    pub revision: String,
    pub document_type: String,
    pub updated_at: String,
    pub status: String,
}

#[derive(Clone, Debug)]
pub(crate) struct DashboardWorkHistoryEntry {
    pub id: String,
    pub work_id: String,
    pub session_id: String,
    pub at: String,
    pub action: String,
    pub title: String,
    pub body: String,
    pub revision: String,
    pub status: String,
}

pub(super) fn work_history(
    root: &Path,
    binding: &ProjectLedgerBinding,
    snapshot: &DashboardLedgerSnapshot,
    work_id: Option<&str>,
    collation: &LocaleCollation,
) -> Result<Vec<DashboardWorkHistoryEntry>, ProjectLedgerReadError> {
    let root = binding::resolve(root, binding)?;
    history::list(&root, binding, snapshot, work_id, collation)
}

pub(super) fn snapshot(
    root: &Path,
    binding: &ProjectLedgerBinding,
    collation: &LocaleCollation,
) -> Result<DashboardLedgerSnapshot, ProjectLedgerReadError> {
    let root = binding::resolve(root, binding)?;
    snapshot::read(&root, binding, collation)
}

pub(super) fn read_ledger_history(
    data_root: &Path,
    ledger_project_id: &str,
) -> Result<DashboardLedgerHistory, ProjectLedgerReadError> {
    let root = binding::resolve_ledger_root(data_root, ledger_project_id)?;
    ledger_history::read(&root)
}

pub(super) fn read_source(
    root: &Path,
    binding: &ProjectLedgerBinding,
    kind: &str,
    id: &str,
    expected_revision: &str,
    collation: &LocaleCollation,
) -> Result<DashboardLedgerSource, ProjectLedgerReadError> {
    let root = binding::resolve(root, binding)
        .map_err(|_| ProjectLedgerReadError::DashboardInternal("dashboard_binding_unavailable"))?;
    let snapshot = snapshot::read(&root, binding, collation)
        .map_err(|_| ProjectLedgerReadError::DashboardInternal("dashboard_snapshot_unavailable"))?;
    if kind == "reference" {
        return history::read_reference(
            &root,
            binding,
            &snapshot,
            id,
            expected_revision,
            collation,
        );
    }
    let source =
        exact::read_source(&root, binding, &snapshot, kind, id, collation).map_err(|_| {
            ProjectLedgerReadError::DashboardUnavailable("dashboard_source_unavailable")
        })?;
    if expected_revision != snapshot.revision && expected_revision != source.revision {
        return Err(ProjectLedgerReadError::DashboardChanged);
    }
    Ok(source)
}
