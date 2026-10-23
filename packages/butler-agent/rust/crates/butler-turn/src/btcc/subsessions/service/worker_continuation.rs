//! A Worker direction continues its session through the existing Work lifecycle.
use super::*;

impl SubsessionService {
    pub(super) async fn bind_worker_continuation(
        &self,
        stored: &crate::btcc::StoredSubsessionDelegation,
        scope: WorkTurnScope,
    ) -> Result<(), BtccError> {
        if self
            .work
            .bind_open_work(scope.clone(), None)
            .await?
            .is_some()
        {
            return Ok(());
        }
        // Cancellation/completion can close the original Work. Keep its history
        // intact and use normal Work creation for this direction's new turn.
        let objective = self
            .repository
            .pending_direction(stored.relation_id.clone())
            .await
            .map_err(BtccError::from)?
            .map(|direction| direction.instruction)
            .unwrap_or_else(|| stored.packet.objective.clone());
        self.work
            .start_work(StartWorkInput {
                mutation_call_id: format!(
                    "subsession-continuation-work:{}:{}",
                    stored.delegation_id, scope.turn_id
                ),
                scope,
                objective,
                backfill_tool_call_ids: None,
            })
            .await?;
        Ok(())
    }
}
