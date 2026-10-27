//! Continue already-decided siblings without depending on another App poll.
use super::*;

impl TurnRuntime {
    pub(super) async fn run_until_undecided(
        &self,
        mut turn: TurnRecord,
        conversation: &dyn PreparedConversation,
        destination: &ProgressDestination,
        attempt: u32,
        command: &crate::btcc::TurnCommand,
    ) -> Result<TurnRecord, BtccError> {
        loop {
            if let crate::btcc::TurnCommand::Resume(resume) = command
                && let Some(ceiling) = &resume.access_ceiling
            {
                let policy = crate::btcc::guided_turn::GuidedExecutionPolicy::from_turn(&turn, "")
                    .map_err(|_| {
                        BtccError::relayed(
                            "delegation_parent_policy_invalid",
                            "Work policy is unavailable.",
                        )
                    })?;
                let context = turn
                    .context
                    .get_mut("executionPolicy")
                    .and_then(serde_json::Value::as_object_mut)
                    .ok_or_else(|| {
                        BtccError::relayed(
                            "delegation_parent_policy_invalid",
                            "Work policy is unavailable.",
                        )
                    })?;
                context.insert(
                    "accessMode".into(),
                    serde_json::json!(policy.access_mode.narrower(ceiling.clone())),
                );
                release_requirements(context, "requiredNativeTools", &resume.released_tools);
                release_requirements(
                    context,
                    "requiredNativeToolProfiles",
                    &resume.released_profiles,
                );
            }
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

fn release_requirements(
    context: &mut serde_json::Map<String, serde_json::Value>,
    field: &str,
    released: &[String],
) {
    if let Some(values) = context
        .get_mut(field)
        .and_then(serde_json::Value::as_array_mut)
    {
        values.retain(|v| {
            v.as_str()
                .is_none_or(|name| !released.iter().any(|old| old == name))
        });
    }
}
