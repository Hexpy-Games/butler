//! Concrete native Project Ledger reader to BTCC active-Plan projection.

#[cfg(test)]
use std::path::Path;

use crate::btcc::{ProjectLedgerPlan, ProjectLedgerPlanInput, accepted_project_plan};
use crate::project_ledger::{NativeProjectLedger, PlanRecordRead, ProjectLedgerReadError};

#[derive(Clone)]
pub(crate) struct NativeAcceptedPlanProducer {
    ledger: NativeProjectLedger,
}

impl NativeAcceptedPlanProducer {
    #[cfg(test)]
    pub(crate) fn new(butler_data: &Path, max_blocking_reads: usize) -> Self {
        Self::from_ledger(NativeProjectLedger::new(butler_data, max_blocking_reads))
    }

    pub(crate) fn from_ledger(ledger: NativeProjectLedger) -> Self {
        Self { ledger }
    }

    pub(crate) async fn read_accepted(
        &self,
        workspace_path: String,
        app_project_id: String,
        original_plan_id: String,
    ) -> Result<Option<ProjectLedgerPlan>, ProjectLedgerReadError> {
        let expected = original_plan_id.clone();
        let show = match self
            .ledger
            .show_plan_record(PlanRecordRead {
                workspace_path,
                app_project_id,
                plan_id: original_plan_id,
            })
            .await
        {
            Ok(show) => show,
            Err(ProjectLedgerReadError::RecordShow(_)) => return Ok(None),
            Err(error) => return Err(error),
        };
        Ok(accepted_project_plan(
            ProjectLedgerPlanInput {
                id: show.id,
                title: show.title,
                status: show.status,
                body: show.body,
                path: show.path,
            },
            &expected,
        ))
    }

    pub(crate) async fn close(&self) {
        self.ledger.close().await;
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::Value;

    use super::*;

    #[tokio::test]
    async fn concrete_source_writer_record_projects_active_and_maps_show_failure_only() {
        let data = std::env::temp_dir().join(format!("butler-plan-host-{}", uuid::Uuid::new_v4()));
        let workspace = data.join("workspace");
        let root = data.join("project-ledger/projects/demo");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(root.join("plans")).unwrap();
        fs::write(workspace.join("project.json"), r#"{"id":"demo"}"#).unwrap();
        let source: Value =
            serde_json::from_str(include_str!("../project_ledger/tests/source-plan.json")).unwrap();
        for (key, path) in [
            ("project", "project.json"),
            ("ledger", "ledger.jsonl"),
            ("active", "plans/plan-1.md"),
            ("draft", "plans/plan-2.md"),
            ("closed", "plans/plan-3.md"),
        ] {
            fs::write(root.join(path), source[key].as_str().unwrap()).unwrap();
        }
        let producer = NativeAcceptedPlanProducer::new(&data, 1);
        let read = |id: &str| {
            producer.read_accepted(
                workspace.to_string_lossy().into_owned(),
                "demo".into(),
                id.into(),
            )
        };
        let active = read("PLAN-1").await.unwrap().unwrap();
        assert_eq!(
            crate::btcc::render_accepted_project_plan(&active),
            "Accepted Project Ledger Plan:\n- id: PLAN-1\n- title: Active\n- status: active\n\nSource Plan body\nline two"
        );
        assert!(read("PLAN-2").await.unwrap().is_none());
        assert!(read("PLAN-3").await.unwrap().is_none());
        assert!(read("MISSING").await.unwrap().is_none());
        assert!(read(" PLAN-1 ").await.unwrap().is_none());
        fs::write(workspace.join("project.json"), r#"{"id":"escape"}"#).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            fs::create_dir_all(data.join("outside")).unwrap();
            symlink(
                data.join("outside"),
                data.join("project-ledger/projects/escape"),
            )
            .unwrap();
            assert_eq!(
                read("PLAN-1").await,
                Err(ProjectLedgerReadError::Resolution(
                    "active_project_ledger_path_escape"
                ))
            );
        }
        producer.close().await;
        fs::remove_dir_all(data).unwrap();
    }
}
