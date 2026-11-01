//! Per-turn prompt composition shares its mutable reminder projection with tools.
use super::GuidedTurnFactoryAdapter;
use crate::host::guided::prompt::{GuidedTextState, open_asks::Reminders};
use butler_turn::btcc::{
    BtccError, GuidedPhaseSelection, GuidedWork, PolicyRole, ProjectLedgerPlan, TurnRecord,
    WorkTurnScope,
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
pub(super) async fn surface(
    factory: &GuidedTurnFactoryAdapter,
    turn: &TurnRecord,
    phase: &mut GuidedPhaseSelection,
) -> Result<
    (
        Vec<butler_turn::btcc::ModelRoundTool>,
        Arc<Mutex<Reminders>>,
    ),
    BtccError,
> {
    let tools = factory.tool_surface(phase).await?;
    let reminders = reminders(factory, turn, &phase.execution_policy.role).await?;
    Ok((tools, reminders))
}
async fn reminders(
    factory: &GuidedTurnFactoryAdapter,
    turn: &TurnRecord,
    role: &PolicyRole,
) -> Result<Arc<Mutex<Reminders>>, BtccError> {
    if matches!(role, PolicyRole::Steward | PolicyRole::Worker) {
        return Ok(Arc::new(Mutex::new(Reminders::new(Vec::new()))));
    }
    let mut entries = factory
        .preparation
        .authority
        .ask_reminders(turn.session_id.clone(), turn.turn_id.clone())
        .await?;
    let owner = turn.session_id.clone();
    let mut canon = factory
        .documents
        .canon_storage()
        .canon_read(move |db| {
            butler_canon::store::open_canon_proposals(db, Some(&owner), 201, None, "en")
        })
        .await
        .map_err(|e| BtccError::relayed(e.code(), e.message()))?;
    for entry in &mut canon {
        entry["resolved_at"] = serde_json::Value::Null;
    }
    entries.extend(canon);
    Ok(Arc::new(Mutex::new(Reminders::new(entries))))
}
pub(super) async fn state(
    factory: &GuidedTurnFactoryAdapter,
    input: Inputs,
) -> Result<GuidedTextState, BtccError> {
    Ok(GuidedTextState {
        last_run_note: tokio::sync::Mutex::new(None),
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
