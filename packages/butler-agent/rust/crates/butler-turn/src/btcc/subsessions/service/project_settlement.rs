//! The pending parent-result outbox also owns retry of Ledger settlement.
use super::*;
use crate::btcc::{DispositionInput, DispositionStatus, DurableWorkStatus, WorkScope};

impl SubsessionService {
    /// Settles canonical project Work before the parent result can be delivered.
    pub async fn settle_parent_result(
        &self,
        pending: &crate::btcc::storage::PendingParentInput,
    ) -> Result<(), BtccError> {
        let crate::btcc::ParentResultInput::ButlerApp(input) = &pending.input else {
            return Ok(());
        };
        let relation = self
            .repository
            .relation_by_id(input.relation_id.clone())
            .await
            .map_err(BtccError::from)?
            .ok_or_else(|| error(BtccCode::SubsessionRelationMissing))?;
        let Some(parent) = &relation.packet.parent_work_ref else {
            return Ok(());
        };
        let Some(work) = self
            .work
            .work_for_turn(relation.parent_turn_id.clone(), parent.work_id.clone())
            .await?
        else {
            return Ok(());
        };
        if !matches!(work.scope, WorkScope::Project { .. })
            || work.work_id != parent.work_id
            || !matches!(
                work.status,
                DurableWorkStatus::Open | DurableWorkStatus::Blocked
            )
            || work
                .current_plan
                .as_ref()
                .is_none_or(|plan| plan.plan_revision_id != parent.plan_revision_id)
        {
            return Ok(());
        }
        let result = self
            .repository
            .settlement_result(pending.result_id.clone())
            .await
            .map_err(BtccError::from)?
            .ok_or_else(|| error(BtccCode::SubsessionRelationMissing))?;
        let input = settlement_input(&relation, &work, &result, &pending.result_id)?;
        self.work
            .disposition(input, Some(pending.result_id.clone()))
            .await?;
        Ok(())
    }
}

fn settlement_input(
    relation: &crate::btcc::StoredSubsessionDelegation,
    work: &WorkView,
    result: &Value,
    result_id: &str,
) -> Result<DispositionInput, BtccError> {
    let status = result["status"].as_str().unwrap_or_default();
    let disposition = match status {
        "success" | "completed" => DispositionStatus::Completed,
        "cancelled" | "abandoned" => DispositionStatus::Open,
        _ => DispositionStatus::Blocked,
    };
    let summary = result["summary"].as_str().unwrap_or_default().to_owned();
    let evidence = serde_json::from_value(result["acceptance_evidence"].clone())
        .map_err(|e| BtccError::relayed("delegated_result_invalid", e.to_string()))?;
    let project_ref = match &work.scope {
        WorkScope::Project { project_ref } => Some(project_ref.clone()),
        WorkScope::Session { .. } => None,
    };
    let actions = work
        .action_progress
        .iter()
        .map(|action| crate::btcc::DispositionActionUpdate {
            action_key: action.action_key.clone(),
            status: match disposition {
                DispositionStatus::Completed => ActionStatus::Done,
                DispositionStatus::Blocked => ActionStatus::Blocked,
                DispositionStatus::Open => ActionStatus::Skipped,
            },
            note: Some(summary.clone()),
        })
        .collect();
    Ok(DispositionInput {
        scope: WorkTurnScope {
            // Settlement, like session Work, records the terminal result Turn as provenance.
            turn_id: result["child_turn_id"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            session_id: relation.parent_session_id.clone(),
            project_ref,
        },
        mutation_call_id: crate::btcc::digest_identity(&format!("one-call-result\0{result_id}")),
        work_id: work.work_id.clone(),
        disposition,
        summary: summary.clone(),
        action_updates: Some(actions),
        remaining_actions: None,
        next_condition: (disposition == DispositionStatus::Blocked).then_some(summary),
        evidence_refs: Some(evidence),
        followups: None,
        backfill_tool_call_ids: None,
        expected_material_fingerprint: None,
        runtime_owned_open_generation: None,
    })
}
