//! Continue already-decided siblings without depending on another App poll.
use super::*;

impl TurnRuntime {
    pub(super) async fn run_until_undecided(
        &self,
        mut turn: TurnRecord,
        conversation: &dyn PreparedConversation,
        destination: &ProgressDestination,
        attempt: u32,
    ) -> Result<TurnRecord, BtccError> {
        loop {
            let recovery_turn_id = turn.turn_id.clone();
            turn = match self
                .run_agent(turn, conversation, destination, attempt)
                .await
            {
                Ok(turn) => turn,
                Err(error) => match self.store.find_turn(&recovery_turn_id).await {
                    Ok(Some(current)) if current.semantic_state == TurnSemanticState::Cancelled => {
                        current
                    }
                    _ => return Err(error),
                },
            };
            if turn.suspension != Some(SuspensionReason::AuthorityPending) {
                return Ok(turn);
            }
            let resumed = self
                .store
                .resume_authority(&turn.turn_id)
                .await?
                .unwrap_or_else(|| turn.clone());
            if resumed.suspension.is_some() || resumed.semantic_state != TurnSemanticState::Admitted
            {
                return Ok(resumed);
            }
            turn = resumed;
        }
    }
}
