//! Session Plan decisions through the existing canonical Project Ledger owner.

use serde_json::json;

use butler_gateway::gateway::AppPlanDecisionLedgerError;
use butler_gateway::gateway::AppPlanDecisionLedgerFuture;
use butler_gateway::gateway::AppPlanDecisionLedgerPort;
use butler_gateway::gateway::AppPlanDecisionPlan;
use butler_gateway::gateway::AppPlanDecisionStatus;
use butler_ledger::project_ledger::LedgerCommand;
use butler_ledger::project_ledger::LedgerCommandRequest;
use butler_ledger::project_ledger::PlanRecordRead;
use butler_ledger::project_ledger::ProjectLedger;

pub(crate) struct AppPlanDecisionLedger {
    ledger: ProjectLedger,
}

impl AppPlanDecisionLedger {
    pub(crate) fn new(ledger: ProjectLedger) -> Self {
        Self { ledger }
    }
}

impl AppPlanDecisionLedgerPort for AppPlanDecisionLedger {
    fn read_plan(
        &self,
        app_project_id: String,
        ledger_project_id: String,
        plan_id: String,
    ) -> AppPlanDecisionLedgerFuture<Option<AppPlanDecisionPlan>> {
        let ledger = self.ledger.clone();
        Box::pin(async move {
            let root = ledger
                .resolve_app_plan_root(app_project_id.clone(), ledger_project_id)
                .await
                .map_err(|source| AppPlanDecisionLedgerError::unavailable().with_source(source))?;
            let Ok(plan) = ledger
                .show_plan_record(PlanRecordRead {
                    workspace_path: root.to_string_lossy().into_owned(),
                    app_project_id,
                    plan_id: plan_id.clone(),
                })
                .await
            else {
                return Ok(None);
            };
            if plan.id != plan_id || plan.title.is_empty() {
                return Ok(None);
            }
            let Some(body) = plan.body.filter(|body| !body.is_empty()) else {
                return Ok(None);
            };
            Ok(Some(AppPlanDecisionPlan {
                id: plan.id,
                title: plan.title,
                status: plan.status,
                body,
            }))
        })
    }

    fn update_plan_status(
        &self,
        app_project_id: String,
        ledger_project_id: String,
        plan_id: String,
        status: AppPlanDecisionStatus,
    ) -> AppPlanDecisionLedgerFuture<()> {
        let ledger = self.ledger.clone();
        Box::pin(async move {
            let root = ledger
                .resolve_app_plan_root(app_project_id, ledger_project_id)
                .await
                .map_err(|source| AppPlanDecisionLedgerError::unavailable().with_source(source))?;
            let result = ledger
                .execute_command(LedgerCommandRequest {
                    project_root: root,
                    command: LedgerCommand::RecordUpdate,
                    options: json!({"kind":"plan","id":plan_id,"status":status.as_str()}),
                })
                .await
                .map_err(|source| AppPlanDecisionLedgerError::internal().with_source(source))?;
            if result.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
                return Err(AppPlanDecisionLedgerError::Changed);
            }
            Ok(())
        })
    }
}
