//! Existing component fixture assembly, excluded from the native executable.

use super::*;

pub(crate) struct FixtureAgentLoop {
    pub(super) model: Arc<dyn ModelRoundPort>,
    pub(super) execution_factory: Arc<dyn crate::btcc::model_route::ModelExecutionFactory>,
    pub(super) policy: Arc<dyn GuidedPolicyPort>,
    pub(super) operation_result_factory: Arc<dyn OperationResultRuntimeFactory>,
    pub(super) work_scope: Arc<dyn TurnWorkScopePort>,
    pub(super) budget_factory: Arc<crate::btcc::GuidedContinuationBudgetFactory>,
    pub(super) observer: Option<Arc<dyn AgentLoopObserver>>,
}

impl FixtureAgentLoop {
    #[expect(
        clippy::too_many_arguments,
        reason = "This test-only composition constructor wires each required BTCC collaborator explicitly."
    )]
    pub(crate) fn guided(
        model: Arc<dyn ModelRoundPort>,
        execution_factory: Arc<dyn crate::btcc::model_route::ModelExecutionFactory>,
        dependencies: GuidedPolicyDependencies,
        authority_decision: Option<AuthorityDecision>,
        operation_result_factory: Arc<dyn OperationResultRuntimeFactory>,
        work_scope: Arc<dyn TurnWorkScopePort>,
        budget_factory: Arc<crate::btcc::GuidedContinuationBudgetFactory>,
        observer: Option<Arc<dyn AgentLoopObserver>>,
    ) -> Self {
        Self {
            model,
            execution_factory,
            policy: Arc::new(guided_policy::GuidedPolicy::new(
                dependencies,
                authority_decision,
            )),
            operation_result_factory,
            work_scope,
            budget_factory,
            observer,
        }
    }
}

impl AgentLoop for FixtureAgentLoop {
    fn run<'a>(
        &'a self,
        turn: &'a TurnRecord,
        claim: &'a StateExecutionClaim,
        recovery_attempt: u32,
        progress: &'a dyn AgentLoopProgress,
        model_round_observer: &'a dyn crate::btcc::ModelRoundObserver,
        cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<AgentLoopResult, AgentLoopError>> + Send + 'a>> {
        Box::pin(async move {
            let semantic =
                contracts::SemanticTurn::parse(turn).map_err(AgentLoopError::Propagate)?;
            let work_id = self
                .work_scope
                .initial_work_id(turn, claim)
                .await
                .map_err(AgentLoopError::Propagate)?;
            let operation_results = self
                .operation_result_factory
                .bind(operation_result_replay::OperationResultScope {
                    turn_id: turn.turn_id.clone(),
                    turn_revision: turn.revision,
                    session_id: turn.session_id.clone(),
                    project_ref: semantic
                        .context
                        .execution_policy
                        .as_ref()
                        .and_then(|policy| policy.project_id.clone())
                        .or_else(|| semantic.context.project_ref.clone()),
                    work_id,
                })
                .map_err(AgentLoopError::Propagate)?;
            let budget = self
                .budget_factory
                .bind(turn, claim)
                .map_err(AgentLoopError::Propagate)?;
            let execution = self
                .execution_factory
                .create(crate::btcc::model_route::ModelExecutionInput {
                    source_revision: crate::btcc::model_route::GuidedSourceRevision::from_turn(
                        turn,
                    ),
                    turn,
                    claim,
                    progress,
                    model_round_observer,
                    cancellation: cancellation.clone(),
                    base: self.model.as_ref(),
                })
                .await
                .map_err(AgentLoopError::Propagate)?;
            run(driver::Invocation {
                turn,
                claim,
                recovery_attempt,
                progress,
                model_round_observer,
                semantic,
                cancellation,
                model: execution.routed(),
                model_execution: execution.as_ref(),
                policy: self.policy.as_ref(),
                operation_results: operation_results.as_deref(),
                budget,
                observer: self.observer.as_deref(),
            })
            .await
        })
    }
}
