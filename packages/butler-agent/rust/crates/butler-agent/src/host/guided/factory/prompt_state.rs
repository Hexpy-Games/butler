//! Per-turn prompt composition shares its mutable reminder projection with tools.
use super::GuidedTurnFactoryAdapter;
use crate::host::guided::prompt::{GuidedTextState, open_asks::Reminders};
use butler_turn::btcc::{
    BtccError, GuidedPhaseSelection, GuidedWork, ProjectLedgerPlan, TurnRecord, WorkTurnScope,
};
use parking_lot::Mutex;
use std::sync::Arc;

pub(super) struct Inputs {
    pub open_asks: Arc<Mutex<Reminders>>,
    pub phase: GuidedPhaseSelection,
    pub work: GuidedWork,
    pub work_scope: WorkTurnScope,
    pub accepted_plan: Option<ProjectLedgerPlan>,
    pub response_language: String,
    pub continuation_budget_enabled: bool,
}
pub(super) async fn reminders(
    factory: &GuidedTurnFactoryAdapter,
    turn: &TurnRecord,
) -> Result<Arc<Mutex<Reminders>>, BtccError> {
    let entries = factory
        .preparation
        .authority
        .ask_reminders(turn.session_id.clone(), turn.turn_id.clone())
        .await?;
    Ok(Arc::new(Mutex::new(Reminders::new(entries))))
}
pub(super) async fn state(
    factory: &GuidedTurnFactoryAdapter,
    input: Inputs,
) -> Result<GuidedTextState, BtccError> {
    Ok(GuidedTextState {
        skill_catalog: factory
            .skill_catalog(input.phase.execution_policy.project_id.clone())
            .await?,
        open_asks: input.open_asks,
        phase: input.phase,
        work: input.work,
        work_service: factory.preparation.work.clone(),
        work_scope: input.work_scope,
        documents: factory.documents.clone(),
        journal: factory.preparation.journal.clone(),
        attachment_context: factory.attachment_context.clone(),
        effects: factory.effects.clone(),
        accepted_plan: input.accepted_plan,
        butler_data: factory.butler_data.to_string_lossy().into_owned(),
        response_language: input.response_language,
        continuation_budget_enabled: input.continuation_budget_enabled,
        work_streams: factory.work_streams.clone(),
        subsessions: factory.subsessions.clone(),
    })
}
