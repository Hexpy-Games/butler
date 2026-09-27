//! Host translation between App dashboard facts and the Project Ledger owner.

use crate::gateway::AppProjectDashboardActionProgress;
use crate::gateway::AppProjectDashboardCheckpoint;
use crate::gateway::AppProjectDashboardDisposition;
use crate::gateway::AppProjectDashboardLedgerError;
use crate::gateway::AppProjectDashboardLedgerEvent;
use crate::gateway::AppProjectDashboardLedgerFuture;
use crate::gateway::AppProjectDashboardLedgerHistory;
use crate::gateway::AppProjectDashboardLedgerPort;
use crate::gateway::AppProjectDashboardLedgerRecord;
use crate::gateway::AppProjectDashboardManagedPlan;
use crate::gateway::AppProjectDashboardManagedWork;
use crate::gateway::AppProjectDashboardReview;
use crate::gateway::AppProjectDashboardSnapshot;
use crate::gateway::AppProjectDashboardSource;
use crate::gateway::AppProjectDashboardWork;
use crate::gateway::AppProjectDashboardWorkHistoryEntry;
use butler_ledger::project_ledger::DashboardLedgerRecord;
use butler_ledger::project_ledger::DashboardLedgerSnapshot;
use butler_ledger::project_ledger::DashboardLedgerSource;
use butler_ledger::project_ledger::DashboardManagedWorkView;
use butler_ledger::project_ledger::DashboardWorkHistoryEntry;
use butler_ledger::project_ledger::ProjectLedger;
use butler_ledger::project_ledger::ProjectLedgerBinding;
use butler_ledger::project_ledger::ProjectLedgerReadError;

pub(crate) struct AppDashboardLedger {
    ledger: ProjectLedger,
}

impl AppDashboardLedger {
    pub(crate) fn new(ledger: ProjectLedger) -> Self {
        Self { ledger }
    }
}

impl AppProjectDashboardLedgerPort for AppDashboardLedger {
    fn snapshot(
        &self,
        app_project_id: String,
        ledger_project_id: String,
    ) -> AppProjectDashboardLedgerFuture<AppProjectDashboardSnapshot> {
        let ledger = self.ledger.clone();
        Box::pin(async move {
            let snapshot = ledger
                .dashboard_snapshot(binding(app_project_id, ledger_project_id))
                .await
                .map_err(map_error)?;
            Ok(project_snapshot(snapshot))
        })
    }

    fn source(
        &self,
        app_project_id: String,
        ledger_project_id: String,
        kind: String,
        id: String,
        expected_revision: String,
    ) -> AppProjectDashboardLedgerFuture<AppProjectDashboardSource> {
        let ledger = self.ledger.clone();
        Box::pin(async move {
            let source = ledger
                .read_dashboard_source(
                    binding(app_project_id, ledger_project_id),
                    kind,
                    id,
                    expected_revision,
                )
                .await
                .map_err(map_error)?;
            Ok(project_source(source))
        })
    }

    fn history(
        &self,
        ledger_project_id: String,
    ) -> AppProjectDashboardLedgerFuture<AppProjectDashboardLedgerHistory> {
        let ledger = self.ledger.clone();
        Box::pin(async move {
            let history = ledger
                .read_dashboard_ledger_history(ledger_project_id)
                .await
                .map_err(map_error)?;
            Ok(AppProjectDashboardLedgerHistory {
                revision: history.revision,
                events: history
                    .events
                    .into_iter()
                    .map(|event| AppProjectDashboardLedgerEvent {
                        id: event.id,
                        record_id: event.record_id,
                        kind: event.kind,
                        action: event.action,
                        at: event.at,
                    })
                    .collect(),
            })
        })
    }

    fn work_history(
        &self,
        app_project_id: String,
        ledger_project_id: String,
        expected_snapshot_revision: String,
        work_id: Option<String>,
    ) -> AppProjectDashboardLedgerFuture<Vec<AppProjectDashboardWorkHistoryEntry>> {
        let ledger = self.ledger.clone();
        Box::pin(async move {
            let history = ledger
                .dashboard_work_history_for_revision(
                    binding(app_project_id, ledger_project_id),
                    expected_snapshot_revision,
                    work_id,
                )
                .await
                .map_err(map_error)?;
            Ok(history.into_iter().map(project_work_history).collect())
        })
    }
}

fn binding(app_project_id: String, ledger_project_id: String) -> ProjectLedgerBinding {
    ProjectLedgerBinding {
        app_project_id,
        ledger_project_id,
    }
}

fn map_error(error: ProjectLedgerReadError) -> AppProjectDashboardLedgerError {
    match error {
        ProjectLedgerReadError::DashboardChanged => AppProjectDashboardLedgerError::Changed,
        ProjectLedgerReadError::DashboardUnavailable { code: _, .. } => {
            AppProjectDashboardLedgerError::unavailable().with_source(error)
        }
        ProjectLedgerReadError::Resolution { code: _, .. }
        | ProjectLedgerReadError::RecordShow { code: _, .. }
        | ProjectLedgerReadError::Owner { code: _, .. }
        | ProjectLedgerReadError::DashboardInternal { code: _, .. } => {
            AppProjectDashboardLedgerError::internal().with_source(error)
        }
    }
}

fn project_record(record: DashboardLedgerRecord) -> AppProjectDashboardLedgerRecord {
    AppProjectDashboardLedgerRecord {
        id: record.id,
        kind: record.kind,
        title: record.title,
        status: record.status,
        path: record.path,
        parent_id: record.parent_id,
        spec: record.spec,
        updated_at: record.updated_at,
        unavailable: record.unavailable,
        priority: record.priority,
    }
}

fn project_snapshot(snapshot: DashboardLedgerSnapshot) -> AppProjectDashboardSnapshot {
    AppProjectDashboardSnapshot {
        revision: snapshot.revision,
        observed_at: snapshot.observed_at,
        records: snapshot.records.into_iter().map(project_record).collect(),
        works: snapshot
            .works
            .into_iter()
            .map(|work| AppProjectDashboardWork {
                record: project_record(work.record),
                revision: work.revision,
                availability: work.availability.to_owned(),
                managed: work.managed.map(project_managed),
            })
            .collect(),
    }
}

fn project_managed(managed: DashboardManagedWorkView) -> AppProjectDashboardManagedWork {
    AppProjectDashboardManagedWork {
        objective: managed.objective,
        status: managed.status,
        session_id: managed.session_id,
        current_stage: managed.current_stage,
        action_progress: managed
            .action_progress
            .into_iter()
            .map(|entry| AppProjectDashboardActionProgress {
                status: entry.status,
            })
            .collect(),
        current_plan: managed
            .current_plan
            .map(|plan| AppProjectDashboardManagedPlan {
                id: plan.id,
                objective: plan.objective,
                created_at: plan.created_at,
            }),
        latest_checkpoint: managed.latest_checkpoint.map(|checkpoint| {
            AppProjectDashboardCheckpoint {
                created_at: checkpoint.created_at,
                public_summary: Some(checkpoint.public_summary),
                next_step: Some(checkpoint.next_step),
            }
        }),
        latest_disposition: managed.latest_disposition.map(|disposition| {
            AppProjectDashboardDisposition {
                created_at: disposition.created_at,
                summary: Some(disposition.summary),
                remaining_actions: disposition.remaining_actions,
                followups: disposition.followups,
                next_condition: disposition.next_condition,
            }
        }),
        latest_result_review: (!managed.latest_result_review_corrections.is_empty()).then_some(
            AppProjectDashboardReview {
                corrections: managed.latest_result_review_corrections,
            },
        ),
        latest_plan_review: (!managed.latest_plan_review_corrections.is_empty()).then_some(
            AppProjectDashboardReview {
                corrections: managed.latest_plan_review_corrections,
            },
        ),
    }
}

fn project_source(source: DashboardLedgerSource) -> AppProjectDashboardSource {
    AppProjectDashboardSource {
        title: source.title,
        body: source.body,
        revision: source.revision,
        document_type: source.document_type,
        updated_at: source.updated_at,
        status: source.status,
    }
}

fn project_work_history(entry: DashboardWorkHistoryEntry) -> AppProjectDashboardWorkHistoryEntry {
    AppProjectDashboardWorkHistoryEntry {
        id: entry.id,
        work_id: entry.work_id,
        session_id: entry.session_id,
        action: entry.action,
        at: entry.at,
        title: entry.title,
        body: entry.body,
        revision: entry.revision,
        status: entry.status,
    }
}
