mod claim;
mod construct;
mod inbound;
mod types;

use super::common::{error, stringify};
use super::hydration;
use super::{BtccStorage, StorageResult};
use crate::btcc::continuation_budget::TurnContinuationBudgetLimits;
use crate::btcc::turn::TurnRecord;

use crate::btcc::{StorageCode, TurnCommand};
use claim::acquire_claim;
use construct::construct_turn;
use inbound::record_inbound;
use types::{Fresh, Source, text};

pub(super) async fn load_or_admit(
    storage: &BtccStorage,
    command: TurnCommand,
    admission_input_hash: String,
    continuation_limits: Option<TurnContinuationBudgetLimits>,
) -> StorageResult<(TurnRecord, bool)> {
    let turn_id = text(command.turn_id(), "turnId")?.to_owned();
    if let Some(existing) = storage
        .execute({
            let turn_id = turn_id.clone();
            move |connection| hydration::find_turn(connection, &turn_id)
        })
        .await?
    {
        if let Some(fresh) = Fresh::of(&command) {
            assert_replay_identity(&existing, &fresh)?;
        }
        return Ok((existing, false));
    }
    if matches!(command, TurnCommand::Resume(_)) {
        return Err(error(
            StorageCode::TurnNotAdmitted,
            format!("BTCC Turn is not admitted: {turn_id}"),
        ));
    }

    let hash = admission_input_hash;
    let inbox = storage
        .execute(move |connection| record_inbound(connection, &command, &hash))
        .await?;
    if inbox.status == "constructed" {
        let turn = storage
            .execute(move |connection| hydration::find_turn(connection, &inbox.turn_id))
            .await?
            .ok_or_else(|| {
                error(
                    StorageCode::ConstructedTurnMissing,
                    "Constructed BTCC Inbox has no Turn",
                )
            })?;
        return Ok((turn, false));
    }
    let claim = storage
        .execute_with_owner({
            let inbox_id = inbox.inbox_id.clone();
            move |connection, owner| acquire_claim(connection, owner, &inbox_id)
        })
        .await?;
    let turn_id = storage
        .execute_with_owner(move |connection, owner| {
            construct_turn(connection, owner, &inbox, &claim, continuation_limits)
        })
        .await?;
    let turn = storage
        .execute(move |connection| hydration::find_turn(connection, &turn_id))
        .await?
        .ok_or_else(|| {
            error(
                StorageCode::ConstructedTurnMissing,
                "BTCC Turn construction did not persist a Turn",
            )
        })?;
    Ok((turn, true))
}

fn assert_replay_identity(turn: &TurnRecord, command: &Fresh<'_>) -> StorageResult<()> {
    let admitted_content = turn.context.get("messageContent");
    let replay_context = command
        .context
        .as_object()
        .ok_or_else(|| error(StorageCode::InvalidTurnCommand, "missing object: context"))?
        .get("messageContent");
    let basic_match = turn.session_id == text(command.session_id, "sessionId")?
        && turn.trigger_key == text(command.trigger_key, "triggerKey")?
        && turn.original_message_id == command.message_id()?
        && turn.turn_id == text(command.turn_id, "turnId")?;
    if turn.original_message != command.content()?
        || admitted_content.map(stringify).transpose()?
            != replay_context.map(stringify).transpose()?
    {
        butler_core::diagnostic!(
            "warning: admitted replay content mismatch for turn {}",
            turn.turn_id
        );
    }
    let wake_match = match command.source {
        Source::Message(_) => turn.wake_identity.is_none(),
        Source::Trigger(trigger) => {
            let trigger_id = text(&trigger.trigger_id, "triggerId")?;
            let source_turn_id = text(&trigger.source_turn_id, "sourceTurnId")?;
            let authorization_ref = text(&trigger.authorization_ref, "authorizationRef")?;
            let result_scope_ref = trigger.result_scope_ref.as_deref();
            turn.wake_identity.as_ref().is_some_and(|wake| {
                wake.trigger_id == trigger_id
                    && wake.source_turn_id == source_turn_id
                    && wake.authorization_ref == authorization_ref
                    && wake.result_scope_ref.as_deref() == result_scope_ref
            })
        }
    };
    if basic_match && wake_match {
        Ok(())
    } else {
        Err(error(
            StorageCode::TurnReplayConflict,
            format!(
                "BTCC run replay does not match admitted Turn: {}",
                turn.turn_id
            ),
        ))
    }
}
