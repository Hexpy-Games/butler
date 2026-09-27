//! Canonical read-only Project Ledger dashboard sources for App admission.

mod binding;
mod exact;
mod history;
mod ledger_history;
mod managed;
mod snapshot;

use std::path::Path;

use super::ProjectLedgerReadError;
use butler_core::locale::LocaleCollation;

pub use ledger_history::DashboardLedgerHistory;
pub(super) use managed::{decode_child_body, decode_manifest_body};

pub(in crate::project_ledger) fn validate_managed_work(
    root: &Path,
    scope: &butler_turn::btcc::ResolvedProjectWorkScope,
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

/// The App project and the Ledger project it is bound to.
#[derive(Clone, Debug)]
pub struct ProjectLedgerBinding {
    /// The App project id.
    pub app_project_id: String,
    /// The Ledger project id.
    pub ledger_project_id: String,
}

/// One indexed record as the dashboard lists it.
#[derive(Clone, Debug)]
pub struct DashboardLedgerRecord {
    /// The record id.
    pub id: String,
    /// The record kind.
    pub kind: String,
    /// The record title.
    pub title: String,
    /// The record status, or `unknown` when unavailable.
    pub status: String,
    /// The record path under `project-ledger/projects/`.
    pub path: String,
    /// The parent record, for tasks and managed children.
    pub parent_id: Option<String>,
    /// The governing spec id.
    pub spec: Option<String>,
    /// The last update time.
    pub updated_at: String,
    /// Dashboard ordering; lower comes first.
    pub priority: f64,
    /// The source file is missing or unreadable.
    pub unavailable: bool,
}

#[derive(Clone, Debug)]
pub struct DashboardLedgerWork {
    pub record: DashboardLedgerRecord,
    pub revision: Option<String>,
    pub availability: &'static str,
    pub managed: Option<DashboardManagedWorkView>,
}

/// Every dashboard record and Work at one Ledger revision.
#[derive(Clone, Debug)]
pub struct DashboardLedgerSnapshot {
    /// The digest of the binding, publication, index and source metadata.
    pub revision: String,
    /// When the snapshot was read.
    pub observed_at: String,
    /// Indexed records, refreshed from their sources.
    pub records: Vec<DashboardLedgerRecord>,
    /// Every Work, with its managed view when it has one.
    pub works: Vec<DashboardLedgerWork>,
}

/// The public view of one managed (BTCC) Work.
#[derive(Clone, Debug)]
pub struct DashboardManagedWorkView {
    /// The Work objective.
    pub objective: String,
    /// The session that owns the Work.
    pub session_id: String,
    /// The Work status (open, blocked, completed or abandoned).
    pub status: String,
    /// The current Work stage.
    pub current_stage: Option<String>,
    /// Progress of each plan action.
    pub action_progress: Vec<DashboardActionProgress>,
    /// The current plan.
    pub current_plan: Option<DashboardManagedPlanView>,
    /// The latest checkpoint.
    pub latest_checkpoint: Option<DashboardCheckpointSummary>,
    /// The latest disposition.
    pub latest_disposition: Option<DashboardDispositionSummary>,
    /// Corrections from the latest plan review.
    pub latest_plan_review_corrections: Vec<String>,
    /// Corrections from the latest result review.
    pub latest_result_review_corrections: Vec<String>,
    /// The latest public summary.
    pub public_summary: Option<String>,
    /// Actions the latest disposition left open.
    pub remaining_actions: Vec<String>,
    /// Follow-ups the latest disposition named.
    pub followups: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct DashboardActionProgress {
    pub status: String,
}

#[derive(Clone, Debug)]
pub struct DashboardManagedPlanView {
    pub id: String,
    pub objective: String,
    pub created_at: String,
    pub actions: Vec<String>,
    pub checks: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct DashboardCheckpointSummary {
    pub created_at: String,
    pub public_summary: String,
    pub next_step: String,
}

#[derive(Clone, Debug)]
pub struct DashboardDispositionSummary {
    pub created_at: String,
    pub summary: String,
    pub next_condition: Option<String>,
    pub remaining_actions: Vec<String>,
    pub followups: Vec<String>,
}

/// A dashboard source document.
#[derive(Clone, Debug)]
pub struct DashboardLedgerSource {
    /// The document title.
    pub title: String,
    /// The Markdown body shown for it.
    pub body: String,
    /// The digest the caller must present to read it again.
    pub revision: String,
    /// The record kind, or `reference` for history entries.
    pub document_type: String,
    /// The last update time.
    pub updated_at: String,
    /// The record status.
    pub status: String,
}

/// One public entry of managed Work history.
#[derive(Clone, Debug)]
pub struct DashboardWorkHistoryEntry {
    /// `<work id>|<child id>`.
    pub id: String,
    /// The Work id.
    pub work_id: String,
    /// The session that owns the Work.
    pub session_id: String,
    /// When it happened.
    pub at: String,
    /// `reviewed`, `disposition` or `result`.
    pub action: String,
    /// The Work objective.
    pub title: String,
    /// The public JSON projection of the child.
    pub body: String,
    /// The digest of the entry.
    pub revision: String,
    /// The review verdict, disposition or result status.
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
    let root = binding::resolve(root, binding).map_err(|source| {
        ProjectLedgerReadError::dashboard_internal("dashboard_binding_unavailable")
            .with_source(source)
    })?;
    let snapshot = snapshot::read(&root, binding, collation).map_err(|source| {
        ProjectLedgerReadError::dashboard_internal("dashboard_snapshot_unavailable")
            .with_source(source)
    })?;
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
        exact::read_source(&root, binding, &snapshot, kind, id, collation).map_err(|source| {
            ProjectLedgerReadError::dashboard_unavailable("dashboard_source_unavailable")
                .with_source(source)
        })?;
    if expected_revision != snapshot.revision && expected_revision != source.revision {
        return Err(ProjectLedgerReadError::DashboardChanged);
    }
    Ok(source)
}
