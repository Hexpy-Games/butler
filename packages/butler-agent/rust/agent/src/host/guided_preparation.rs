//! Ordered native services for one ordinary Guided Turn's pre-model preparation.

use std::sync::Arc;

use crate::btcc::{
    AuthorityDecision, BtccError, DurableWorkService, ExactResultReplaySelection,
    GuidedAuthorityDecision, GuidedContinuationBudgetFactory, GuidedPhaseInput,
    GuidedPhaseSelection, GuidedPreparationError, GuidedSourceRevision, GuidedTurnStart,
    GuidedWork, NativePrincipalAuthority, OperationResultReplayFactory, OperationResultRepository,
    OperationResultRuntime, OperationResultRuntimeFactory, OperationResultScope, ProjectLedgerPlan,
    ReplayMode, SemanticTurn, ToolJournalRepository, TurnContinuationBudgetPort, WorkTurnScope,
    guided_authority_loop_decision, load_guided_turn_work, select_phase, work_scope_for_turn,
};
use crate::project_ledger::ProjectLedgerReadError;
use crate::workspace::{NativeSessionWorkspaceRecovery, WorkspaceReference};

use super::{NativeAcceptedPlanProducer, NativeGuidedCatalog};

pub(crate) struct NativeGuidedPreparation {
    pub catalog: Arc<NativeGuidedCatalog>,
    pub workspace: NativeSessionWorkspaceRecovery,
    pub accepted_plans: NativeAcceptedPlanProducer,
    pub work: Arc<DurableWorkService>,
    pub authority: Arc<NativePrincipalAuthority>,
    pub journal: Arc<ToolJournalRepository>,
    pub operation_results: Arc<OperationResultRepository>,
    pub budget: Arc<GuidedContinuationBudgetFactory>,
    pub default_workspace: String,
    pub phase_surface_flag: String,
    pub operation_replay_flag: String,
    pub subsessions: Arc<crate::btcc::NativeSubsessionService>,
}

/// No transcript cache or second Work read is introduced during preparation.
pub(crate) struct PreparedNativeGuidedTurn {
    pub semantic: SemanticTurn,
    pub phase: GuidedPhaseSelection,
    pub workspace: WorkspaceReference,
    pub accepted_plan: Option<ProjectLedgerPlan>,
    pub initial_work: GuidedWork,
    pub work_scope: WorkTurnScope,
    pub authority_decision: Option<AuthorityDecision>,
    pub operation_results: Option<Arc<dyn OperationResultRuntime>>,
    pub budget: Option<Arc<dyn TurnContinuationBudgetPort>>,
    pub source_revision: GuidedSourceRevision,
}

impl NativeGuidedPreparation {
    pub(crate) async fn prepare(
        &self,
        start: &GuidedTurnStart<'_>,
    ) -> Result<PreparedNativeGuidedTurn, BtccError> {
        let turn = start.turn;
        let phase = select_phase(GuidedPhaseInput {
            turn,
            catalog: self.catalog.snapshot(),
            phase_surface_flag: &self.phase_surface_flag,
            operation_replay_flag: &self.operation_replay_flag,
            default_workspace: &self.default_workspace,
        })
        .map_err(preparation_error)?;
        let policy = &phase.execution_policy;
        if policy.role == "worker" || policy.role == "steward" {
            self.subsessions
                .ensure_child_work(&turn.session_id, &turn.turn_id)
                .await?;
        } else if policy.role != "butler" {
            return Err(contract("guided_subsession_role_unsupported"));
        }
        let project_id = policy.project_id.as_deref().or_else(|| {
            turn.context
                .get("projectRef")
                .and_then(serde_json::Value::as_str)
        });
        let plan_mode = turn
            .model_selection
            .get("controls")
            .and_then(|v| v.get("planMode"))
            == Some(&serde_json::Value::Bool(true))
            && policy.tracking_mode == "ledger"
            && project_id.is_some_and(|v| !v.is_empty());
        if plan_mode {
            return Err(contract("guided_project_plan_mutation_unsupported"));
        }
        let budget = self.budget.bind(turn, start.claim)?;
        if phase.replay_mode == "available" && turn.model_route.is_none() {
            return Err(contract(
                "operation_result_route_acceptance_dependency_missing",
            ));
        }
        let recovered = self
            .workspace
            .recover(
                &turn.session_id,
                Some(&policy.workspace_path),
                start.cancellation.clone(),
            )
            .await
            .map_err(|e| BtccError::new(e.code, e.message))?;
        let workspace = recovered.workspace_reference;
        let plan_id = turn
            .context
            .get("planId")
            .and_then(serde_json::Value::as_str)
            .filter(|v| !v.is_empty());
        let accepted_plan = if let (Some(plan_id), Some(project)) =
            (plan_id, project_id.filter(|v| !v.is_empty()))
        {
            let path = workspace.get().map_err(|e| contract(&e.code))?;
            self.accepted_plans
                .read_accepted(
                    path.to_string_lossy().into_owned(),
                    project.to_owned(),
                    plan_id.to_owned(),
                )
                .await
                .map_err(ledger_error)?
        } else {
            None
        };
        if plan_id.is_some() && accepted_plan.is_none() {
            return Err(contract("accepted_project_plan_unavailable"));
        }
        let work_scope = work_scope_for_turn(turn, &policy.tracking_mode);
        let path = workspace.get().map_err(|e| contract(&e.code))?;
        let initial_work = load_guided_turn_work(
            &self.work,
            Some(&self.authority),
            turn,
            &policy.tracking_mode,
            &path.to_string_lossy(),
            Some(&turn.session_id),
        )
        .await
        .map_err(preparation_error)?;
        let operation_results = OperationResultReplayFactory::new(
            ExactResultReplaySelection {
                mode: if phase.replay_mode == "available" {
                    ReplayMode::Available
                } else {
                    ReplayMode::Disabled
                },
                exact_read_capability: true,
            },
            self.journal.clone(),
            self.operation_results.clone(),
        )
        .bind(OperationResultScope {
            turn_id: turn.turn_id.clone(),
            turn_revision: turn.revision,
            session_id: turn.session_id.clone(),
            project_ref: project_id.map(str::to_owned),
            work_id: initial_work
                .context
                .as_ref()
                .map(|c| c.work.work_id.clone()),
        })?;
        let authority_decision =
            guided_authority_loop_decision(Some(&self.authority), turn, &turn.session_id)
                .await
                .map_err(preparation_error)?
                .map(|decision| match decision {
                    GuidedAuthorityDecision::Allow => AuthorityDecision::Allow,
                    GuidedAuthorityDecision::Deny => AuthorityDecision::Deny,
                    GuidedAuthorityDecision::Modify(input) => AuthorityDecision::Modify { input },
                });
        let source_revision = GuidedSourceRevision::from_turn(turn);
        // Decode only after the source's preceding workspace, Work and authority reads.
        let semantic = SemanticTurn::parse(turn)?;
        Ok(PreparedNativeGuidedTurn {
            semantic,
            phase,
            workspace,
            accepted_plan,
            initial_work,
            work_scope,
            authority_decision,
            operation_results,
            budget,
            source_revision,
        })
    }
}

fn contract(code: &str) -> BtccError {
    BtccError::new(code, code)
}

#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
fn ledger_error(error: ProjectLedgerReadError) -> BtccError {
    match error {
        ProjectLedgerReadError::Resolution(code)
        | ProjectLedgerReadError::RecordShow(code)
        | ProjectLedgerReadError::Owner(code)
        | ProjectLedgerReadError::DashboardInternal(code)
        | ProjectLedgerReadError::DashboardUnavailable(code) => contract(code),
        ProjectLedgerReadError::DashboardChanged => contract("source_changed"),
    }
}

fn preparation_error(error: GuidedPreparationError) -> BtccError {
    match error {
        GuidedPreparationError::Work(error) => error,
        GuidedPreparationError::Authority(error) => BtccError::new(error.code, error.message),
        GuidedPreparationError::Contract(code) => contract(code),
        GuidedPreparationError::Policy(message) => BtccError::new("guided_policy_invalid", message),
    }
}
