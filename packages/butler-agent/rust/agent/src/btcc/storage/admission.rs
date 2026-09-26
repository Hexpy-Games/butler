mod claim;
mod construct;
mod inbound;
mod types;

use serde_json::Value;

use super::common::{error, stringify};
use super::hydration;
use super::{BtccStorage, StorageResult};
use crate::btcc::continuation_budget::TurnContinuationBudgetLimits;
use crate::btcc::turn::TurnRecord;

use claim::acquire_claim;
use construct::construct_turn;
use inbound::record_inbound;
use types::{kind, object, optional_text_object, text, text_object};

pub(super) async fn load_or_admit(
    storage: &BtccStorage,
    command: Value,
    admission_input_hash: String,
    continuation_limits: Option<TurnContinuationBudgetLimits>,
) -> StorageResult<(TurnRecord, bool)> {
    let turn_id = text(&command, "turnId")?.to_owned();
    if let Some(existing) = storage
        .execute({
            let turn_id = turn_id.clone();
            move |connection| hydration::find_turn(connection, &turn_id)
        })
        .await?
    {
        if kind(&command)? != "resume" {
            assert_replay_identity(&existing, &command)?;
        }
        return Ok((existing, false));
    }
    if kind(&command)? == "resume" {
        return Err(error(
            "turn_not_admitted",
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
                    "constructed_turn_missing",
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
                "constructed_turn_missing",
                "BTCC Turn construction did not persist a Turn",
            )
        })?;
    Ok((turn, true))
}

fn assert_replay_identity(turn: &TurnRecord, command: &Value) -> StorageResult<()> {
    let command_kind = kind(command)?;
    let source = match command_kind {
        "run" => object(command, "message")?,
        "wake" => object(command, "trigger")?,
        _ => {
            return Err(error(
                "invalid_turn_command",
                "BTCC replay command is invalid",
            ));
        }
    };
    let message_id = if command_kind == "run" {
        "messageId"
    } else {
        "triggerId"
    };
    let admitted_content = turn.context.get("messageContent");
    let replay_context = object(command, "context")?.get("messageContent");
    let basic_match = turn.session_id == text(command, "sessionId")?
        && turn.trigger_key == text(command, "triggerKey")?
        && turn.original_message_id == text_object(source, message_id)?
        && turn.original_message == text_object(source, "content")?
        && admitted_content.map(stringify).transpose()?
            == replay_context.map(stringify).transpose()?;
    let wake_match = if command_kind == "run" {
        turn.wake_identity.is_none()
    } else {
        let trigger_id = text_object(source, "triggerId")?;
        let source_turn_id = text_object(source, "sourceTurnId")?;
        let authorization_ref = text_object(source, "authorizationRef")?;
        let result_scope_ref = optional_text_object(source, "resultScopeRef")?;
        let wake = turn.wake_identity.as_ref();
        wake.is_some_and(|wake| {
            wake.trigger_id == trigger_id
                && wake.source_turn_id == source_turn_id
                && wake.authorization_ref == authorization_ref
                && wake.result_scope_ref.as_deref() == result_scope_ref
        })
    };
    if basic_match && wake_match {
        Ok(())
    } else {
        Err(error(
            "turn_replay_conflict",
            format!(
                "BTCC run replay does not match admitted Turn: {}",
                turn.turn_id
            ),
        ))
    }
}
