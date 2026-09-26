use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use super::common::{error, json, stringify};
use super::model::events::assert_claim;
use super::{StorageError, StorageResult};
use crate::btcc::continuation_budget::{
    TurnContinuationBudgetError, TurnContinuationBudgetEvent, parse_turn_continuation_budget_state,
    transition_turn_continuation_budget,
};
use crate::btcc::turn::ContinuationBudgetTransition;

pub(super) struct TransitionResult {
    pub(super) state: Value,
    pub(super) terminal: Option<TurnContinuationBudgetError>,
}

pub(super) fn transition(
    connection: &mut Connection,
    write: &ContinuationBudgetTransition,
) -> StorageResult<TransitionResult> {
    let tx = connection.transaction().map_err(StorageError::sqlite)?;
    assert_claim(
        &tx,
        &write.binding.turn_id,
        write.binding.expected_revision,
        write.binding.execution_fence,
        &write.binding.claim_id,
    )?;
    let raw: Option<String> = tx
        .query_row(
            "SELECT continuation_budget_json FROM btcc_turns WHERE turn_id=?1",
            [&write.binding.turn_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(StorageError::sqlite)?
        .flatten();
    let raw = raw.ok_or_else(|| {
        error(
            "turn_continuation_dependency_missing",
            "turn_continuation_dependency_missing",
        )
    })?;
    let current = parse_turn_continuation_budget_state(
        json(&raw, "invalid_continuation_budget")?,
        &write.binding.turn_id,
    )
    .map_err(|e| error("invalid_continuation_budget", e.message))?;
    let event: TurnContinuationBudgetEvent = serde_json::from_value(write.event.clone())
        .map_err(|e| error("invalid_continuation_budget_event", e.to_string()))?;
    let (next, terminal) = match transition_turn_continuation_budget(current, event, write.now_ms) {
        Ok(next) => (next, None),
        Err(error @ TurnContinuationBudgetError::Exhausted(_)) => (
            error.exhausted_state().cloned().ok_or_else(|| {
                super::common::error(
                    "continuation_terminal_missing",
                    "continuation terminal state missing",
                )
            })?,
            Some(error),
        ),
        Err(TurnContinuationBudgetError::Invalid(error)) => {
            return Err(super::common::error(
                "invalid_continuation_budget",
                error.message,
            ));
        }
    };
    let value =
        serde_json::to_value(&next).map_err(|e| error("continuation_serialize", e.to_string()))?;
    let next_json = stringify(&value)?;
    if next_json != raw {
        let changed = tx
            .execute(
                "UPDATE btcc_turns SET continuation_budget_json=?1 WHERE turn_id=?2
            AND revision=?3 AND execution_fence=?4 AND continuation_budget_json=?5",
                params![
                    next_json,
                    write.binding.turn_id,
                    write.binding.expected_revision,
                    write.binding.execution_fence,
                    raw
                ],
            )
            .map_err(StorageError::sqlite)?;
        if changed != 1 {
            return Err(error(
                "turn_continuation_atomic_update_failed",
                "turn_continuation_atomic_update_failed",
            ));
        }
    }
    tx.commit().map_err(StorageError::sqlite)?;
    Ok(TransitionResult {
        state: value,
        terminal,
    })
}
