use super::common::{error, stringify};
use super::model::events::assert_claim;
use super::{StorageError, StorageResult};
use crate::btcc::StorageCode;
use crate::btcc::continuation_budget::{
    TurnContinuationBudgetError, TurnContinuationBudgetState, transition_turn_continuation_budget,
    validate_turn_continuation_budget_state,
};
use crate::btcc::turn::ContinuationBudgetTransition;
use rusqlite::{Connection, OptionalExtension, params};

pub(super) struct TransitionResult {
    pub(super) state: TurnContinuationBudgetState,
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
            StorageCode::TurnContinuationDependencyMissing,
            "turn_continuation_dependency_missing",
        )
    })?;
    let decoded: TurnContinuationBudgetState = serde_json::from_str(&raw)
        .map_err(|e| error(StorageCode::InvalidContinuationBudget, e.to_string()).with_source(e))?;
    let current = validate_turn_continuation_budget_state(decoded, &write.binding.turn_id)
        .map_err(|e| error(StorageCode::InvalidContinuationBudget, e.message()).with_source(e))?;
    let event = write.event.clone();
    let (next, terminal) = match transition_turn_continuation_budget(current, event, write.now_ms) {
        Ok(next) => (next, None),
        Err(error @ TurnContinuationBudgetError::Exhausted(_)) => (
            error.exhausted_state().cloned().ok_or_else(|| {
                super::common::error(
                    StorageCode::ContinuationTerminalMissing,
                    "continuation terminal state missing",
                )
            })?,
            Some(error),
        ),
        Err(TurnContinuationBudgetError::Invalid(error)) => {
            return Err(super::common::error(
                StorageCode::InvalidContinuationBudget,
                error.message(),
            ));
        }
    };
    let value = serde_json::to_value(&next)
        .map_err(|e| error(StorageCode::ContinuationSerialize, e.to_string()).with_source(e))?;
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
                StorageCode::TurnContinuationAtomicUpdateFailed,
                "turn_continuation_atomic_update_failed",
            ));
        }
    }
    tx.commit().map_err(StorageError::sqlite)?;
    Ok(TransitionResult {
        state: next,
        terminal,
    })
}
