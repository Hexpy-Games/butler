//! Source App session progress from the existing BTCC and Ledger owners.

use std::{collections::HashSet, sync::Arc};

use butler_gateway::gateway::{
    AppSessionWorkProgress, AppWorkProgress, ApplicationFuture, GatewayApplicationError,
};
use butler_ledger::project_ledger::{ProjectLedger, ProjectWorkPlanRead};
use butler_turn::btcc::{SessionPlanObservation, SessionWorkRepository};

mod work_model;

pub(crate) struct AppSessionProgress {
    session_work: Arc<SessionWorkRepository>,
    project_ledger: ProjectLedger,
    work_model: Option<Arc<butler_turn::btcc::work_model::WorkModelService>>,
    queue: Arc<butler_gateway::gateway::InboundQueue>,
    subsessions: butler_turn::btcc::SqliteSubsessionRepository,
    instructions: Arc<butler_turn::btcc::SubsessionService>,
}

impl AppSessionProgress {
    pub(crate) fn new(runtime: &crate::host::runtime::AgentRuntime) -> Self {
        Self {
            session_work: runtime.session_work.clone(),
            project_ledger: runtime.project_ledger.clone(),
            work_model: runtime.work_model.clone(),
            queue: runtime.inbound_queue.clone(),
            subsessions: runtime.subsessions.repository(),
            instructions: runtime.subsessions.clone(),
        }
    }
}

impl AppSessionWorkProgress for AppSessionProgress {
    fn work_model_changes(&self) -> Option<Arc<tokio::sync::Notify>> {
        self.work_model.as_ref().map(|model| model.changed())
    }
    fn work_model(
        &self,
        session: String,
        view: String,
        input: serde_json::Value,
    ) -> ApplicationFuture<serde_json::Value> {
        let service = self.work_model.clone();
        let queue = self.queue.clone();
        let subsessions = self.subsessions.clone();
        let instructions = self.instructions.clone();
        Box::pin(async move {
            let Some(service) = service else {
                return Ok(serde_json::json!({"ok":false,"error":{"code":"work_model_disabled"}}));
            };
            let revision = input
                .get("revision")
                .map(|v| v.as_str().and_then(|v| v.parse::<u64>().ok()).ok_or(()))
                .transpose();
            let Ok(revision) = revision else {
                return Ok(
                    serde_json::json!({"ok":false,"error":{"code":"work_model_revision_invalid"}}),
                );
            };
            let result = if view == "metrics" {
                Ok(
                    serde_json::json!({"storage_operations":service.operation_count(),"btcc_operations":subsessions.storage_operations(),"btcc_sql_statements":subsessions.sql_statements(),"queue_scans":queue.scan_count()}),
                )
            } else {
                work_model::view_and_wake(&service, &instructions, session, &view, input).await
            };
            Ok(work_model::result(result, revision))
        })
    }
    fn read(&self, runtime_session_id: String) -> ApplicationFuture<Option<AppWorkProgress>> {
        let session_work = self.session_work.clone();
        let project_ledger = self.project_ledger.clone();
        Box::pin(async move {
            let observation = session_work
                .observe_session_plan(runtime_session_id)
                .await
                .map_err(GatewayApplicationError::internal_from)?;
            let Some(observation) = observation else {
                return Ok(None);
            };
            let (approved, action_keys, completed_action_keys) = match observation {
                SessionPlanObservation::Session {
                    approved,
                    action_keys,
                    completed_action_keys,
                } => (approved, action_keys, completed_action_keys),
                SessionPlanObservation::Project {
                    work_id,
                    app_project_id,
                    ledger_project_id,
                } => {
                    let Some(facts) = project_ledger
                        .read_project_work_plan(ProjectWorkPlanRead {
                            app_project_id,
                            ledger_project_id,
                            work_id,
                        })
                        .await
                        .map_err(GatewayApplicationError::internal_from)?
                    else {
                        return Ok(None);
                    };
                    (
                        facts.approved,
                        facts.action_keys,
                        facts.completed_action_keys,
                    )
                }
            };
            if !approved || action_keys.is_empty() {
                return Ok(None);
            }
            let completed: HashSet<&str> =
                completed_action_keys.iter().map(String::as_str).collect();
            let count = action_keys
                .iter()
                .filter(|key| completed.contains(key.as_str()))
                .count();
            Ok(Some(AppWorkProgress {
                completed: count,
                total: action_keys.len(),
            }))
        })
    }
}
