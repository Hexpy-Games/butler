//! Source App session progress from the existing BTCC and Ledger owners.

use std::{collections::HashSet, sync::Arc};

use crate::{
    btcc::{SessionPlanObservation, SessionWorkRepository},
    gateway::{
        AppSessionWorkProgress, AppWorkProgress, ApplicationFuture, GatewayApplicationError,
    },
    project_ledger::{NativeProjectLedger, ProjectWorkPlanRead},
};

pub(crate) struct NativeAppSessionProgress {
    session_work: Arc<SessionWorkRepository>,
    project_ledger: NativeProjectLedger,
}

impl NativeAppSessionProgress {
    pub(crate) fn new(
        session_work: Arc<SessionWorkRepository>,
        project_ledger: NativeProjectLedger,
    ) -> Self {
        Self {
            session_work,
            project_ledger,
        }
    }
}

impl AppSessionWorkProgress for NativeAppSessionProgress {
    fn read(&self, runtime_session_id: String) -> ApplicationFuture<Option<AppWorkProgress>> {
        let session_work = self.session_work.clone();
        let project_ledger = self.project_ledger.clone();
        Box::pin(async move {
            let observation = session_work
                .observe_session_plan(runtime_session_id)
                .await
                .map_err(|_| GatewayApplicationError::Internal)?;
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
                        .map_err(|_| GatewayApplicationError::Internal)?
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
