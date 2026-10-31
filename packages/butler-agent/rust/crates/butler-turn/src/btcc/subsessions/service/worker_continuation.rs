//! A direction continues its child session through the existing Work lifecycle.
use super::*;

impl SubsessionService {
    pub(super) async fn bind_continuation(
        &self,
        stored: &crate::btcc::StoredSubsessionDelegation,
        scope: WorkTurnScope,
    ) -> Result<(), BtccError> {
        let steward = stored.packet.child_role == ChildRole::Steward;
        // A Steward's turn joins only the Work its relation currently follows.
        let expected = steward.then(|| stored.root_work_id.clone());
        if self
            .work
            .bind_open_work(scope.clone(), expected)
            .await?
            .is_some()
        {
            return Ok(());
        }
        // Cancellation/completion can close the original Work. Keep its history
        // intact and use normal Work creation for this direction's new turn.
        let direction = self
            .repository
            .pending_direction(stored.relation_id.clone())
            .await
            .map_err(BtccError::from)?;
        // Only a direction starts another Work for a Steward. Any other late
        // turn has nothing to continue.
        if steward
            && !direction.as_ref().is_some_and(|direction| {
                crate::btcc::storage::direction_turn_id(&direction.instruction_id) == scope.turn_id
            })
        {
            return Err(error(BtccCode::SubsessionRootWorkIdentityMismatch));
        }
        let objective = direction
            .map(|direction| direction.instruction)
            .unwrap_or_else(|| stored.packet.objective.clone());
        let mutation_call_id = format!(
            "subsession-continuation-work:{}:{}",
            stored.delegation_id, scope.turn_id
        );
        let work_id = delegation::work_id_of_call(&mutation_call_id);
        // The relation moves first: a crash before the Work exists leaves it
        // closed, never an open Work no relation can reach.
        if steward {
            self.repository
                .follow_work(stored.relation_id.clone(), work_id.clone())
                .await
                .map_err(BtccError::from)?;
        }
        let work = self
            .work
            .start_work(StartWorkInput {
                mutation_call_id,
                scope,
                objective,
                backfill_tool_call_ids: None,
            })
            .await?;
        if steward && work.work_id != work_id {
            return Err(error(BtccCode::SubsessionRootWorkIdentityMismatch));
        }
        Ok(())
    }
}
