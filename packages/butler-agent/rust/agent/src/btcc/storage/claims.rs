use super::operation_input::TurnVersion;
use rusqlite::{Connection, OptionalExtension, params};

use super::common::{error, state_text};
use super::runtime_owner::RuntimeOwner;
use super::{StorageError, StorageResult};
use crate::btcc::identity::digest;
use crate::btcc::turn::{StateExecutionClaim, TurnSemanticState};

struct ClaimRow {
    owner_id: String,
    owner_generation: u64,
    lease_generation: u64,
    checkpoint_revision: u64,
    execution_fence: u64,
    status: String,
}

pub(super) fn acquire(
    connection: &mut Connection,
    owner: &RuntimeOwner,
    turn: &TurnVersion,
) -> StorageResult<StateExecutionClaim> {
    if turn.suspension.is_some()
        || matches!(
            turn.semantic_state,
            TurnSemanticState::Delivered | TurnSemanticState::Cancelled
        )
    {
        return Err(error(
            "terminal_claim",
            "Terminal BTCC R3 Turn cannot acquire an execution claim",
        ));
    }
    let checkpoint = turn.checkpoint.as_ref().ok_or_else(|| {
        error(
            "checkpoint_missing",
            "Nonterminal BTCC Turn has no active checkpoint",
        )
    })?;
    let state = state_text(turn.semantic_state);
    let claim_id = digest(&format!(
        "btcc-state-claim.v1\0{}\0{}\0{state}\0{}",
        turn.turn_id, turn.revision, checkpoint.checkpoint_id
    ));
    let transaction = connection.transaction().map_err(StorageError::sqlite)?;
    assert_exact_turn(&transaction, turn, &checkpoint.checkpoint_id)?;
    transaction.execute(
        "INSERT OR IGNORE INTO btcc_state_claims (claim_id, turn_id, turn_revision, semantic_state, \
         checkpoint_id, checkpoint_revision, execution_fence, owner_id, owner_generation, \
         lease_generation, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, 'active')",
        params![claim_id, turn.turn_id, turn.revision, state, checkpoint.checkpoint_id,
            checkpoint.checkpoint_revision, turn.execution_fence, owner.owner_id(), owner.generation()],
    ).map_err(StorageError::sqlite)?;
    let current = find(&transaction, &claim_id)?
        .ok_or_else(|| error("state_claim_missing", "BTCC state claim was not persisted"))?;
    if current.status == "relinquished"
        || current.owner_id != owner.owner_id()
        || current.owner_generation != owner.generation()
    {
        adopt(
            &transaction,
            owner,
            &claim_id,
            &current,
            checkpoint.checkpoint_revision,
        )?;
    }
    let claimed = find(&transaction, &claim_id)?
        .ok_or_else(|| error("state_claim_missing", "BTCC state claim was not persisted"))?;
    if claimed.owner_id != owner.owner_id()
        || claimed.owner_generation != owner.generation()
        || claimed.status != "active"
        || claimed.checkpoint_revision != checkpoint.checkpoint_revision
        || claimed.execution_fence != turn.execution_fence
    {
        return Err(error(
            "state_claim_inactive",
            "BTCC state is not actively owned by this runtime",
        ));
    }
    let activated = transaction.execute(
        "UPDATE btcc_checkpoints SET active_claim_id = ?1 WHERE checkpoint_id = ?2 \
         AND checkpoint_revision = ?3 AND is_active = 1 AND (active_claim_id IS NULL OR active_claim_id = ?1)",
        params![claim_id, checkpoint.checkpoint_id, checkpoint.checkpoint_revision],
    ).map_err(StorageError::sqlite)?;
    if activated != 1 {
        return Err(error(
            "checkpoint_claimed",
            "BTCC checkpoint is already claimed by another runtime",
        ));
    }
    transaction.commit().map_err(StorageError::sqlite)?;
    Ok(StateExecutionClaim {
        claim_id,
        turn_id: turn.turn_id.clone(),
        turn_revision: turn.revision,
        semantic_state: turn.semantic_state,
        checkpoint_id: checkpoint.checkpoint_id.clone(),
        checkpoint_revision: checkpoint.checkpoint_revision,
        execution_fence: turn.execution_fence,
    })
}

fn adopt(
    connection: &Connection,
    owner: &RuntimeOwner,
    claim_id: &str,
    claim: &ClaimRow,
    checkpoint_revision: u64,
) -> StorageResult<()> {
    if claim.status != "relinquished" && !owner.can_adopt_claim_from(connection, &claim.owner_id)? {
        return Err(error(
            "state_claim_live",
            "BTCC state is actively owned by another live runtime",
        ));
    }
    let changed = connection
        .execute(
            "UPDATE btcc_state_claims SET status = 'active', owner_id = ?1, owner_generation = ?2, \
         lease_generation = lease_generation + 1 WHERE claim_id = ?3 AND owner_id = ?4 \
         AND owner_generation = ?5 AND lease_generation = ?6 AND checkpoint_revision = ?7 \
         AND execution_fence = ?8 AND status = ?9",
            params![
                owner.owner_id(),
                owner.generation(),
                claim_id,
                claim.owner_id,
                claim.owner_generation,
                claim.lease_generation,
                checkpoint_revision,
                claim.execution_fence,
                claim.status
            ],
        )
        .map_err(StorageError::sqlite)?;
    if changed != 1 {
        return Err(error(
            "state_claim_adoption_raced",
            "BTCC state claim adoption raced",
        ));
    }
    Ok(())
}

fn find(connection: &Connection, claim_id: &str) -> StorageResult<Option<ClaimRow>> {
    connection
        .query_row(
            "SELECT owner_id, owner_generation, lease_generation, checkpoint_revision, \
         execution_fence, status FROM btcc_state_claims WHERE claim_id = ?1",
            [claim_id],
            |row| {
                Ok(ClaimRow {
                    owner_id: row.get(0)?,
                    owner_generation: row.get(1)?,
                    lease_generation: row.get(2)?,
                    checkpoint_revision: row.get(3)?,
                    execution_fence: row.get(4)?,
                    status: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(StorageError::sqlite)
}

fn assert_exact_turn(
    connection: &Connection,
    turn: &TurnVersion,
    checkpoint_id: &str,
) -> StorageResult<()> {
    let current = connection
        .query_row(
            "SELECT semantic_state, revision, execution_fence, active_checkpoint_id \
         FROM btcc_turns WHERE turn_id = ?1",
            [&turn.turn_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, u64>(1)?,
                    row.get::<_, u64>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    if !current.is_some_and(|current| {
        current.0 == state_text(turn.semantic_state)
            && current.1 == turn.revision
            && current.2 == turn.execution_fence
            && current.3 == checkpoint_id
    }) {
        return Err(error(
            "state_claim_stale_turn",
            "BTCC StateExecutionClaim lost its exact Turn revision",
        ));
    }
    Ok(())
}
