use rusqlite::{
    Connection, OptionalExtension, Statement, Transaction, TransactionBehavior, params,
};
use serde_json::json;

use super::records;
use crate::btcc::StorageCode;
use crate::btcc::identity::{content_ref, digest};
use crate::btcc::storage::common::{error, route_text, stringify};
use crate::btcc::storage::{StorageError, StorageResult, hydration, worker_result_turn_id};
use crate::btcc::turn::{
    FinalPayload, SettledTurn, SuspensionReason, TurnRecord, TurnSemanticState,
};

pub(in crate::btcc::storage) fn settled_turns(
    db: &mut Connection,
    session_id: &str,
) -> StorageResult<Vec<SettledTurn>> {
    let mut waiting = db.prepare(
        "SELECT turn_id, rowid FROM btcc_turns INDEXED BY idx_btcc_turns_worker_waiting
         WHERE session_id=?1 AND semantic_state='admitted' AND suspension_reason='waiting_for_worker' ORDER BY rowid",
    ).map_err(StorageError::sqlite)?;
    let waiting = waiting
        .query_map([session_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(StorageError::sqlite)?;
    let mut own = db
        .prepare(
            "SELECT r.relation_id, r.activity_terminal, pt.rowid FROM btcc_session_relations r
         JOIN btcc_turns pt ON pt.turn_id=r.parent_turn_id
         WHERE r.parent_session_id=?1 AND r.parent_turn_id=?2",
        )
        .map_err(StorageError::sqlite)?;
    let mut earlier = db
        .prepare(
            "SELECT r.relation_id, r.activity_terminal, pt.rowid FROM btcc_session_relations r
         JOIN btcc_turns pt ON pt.turn_id=r.parent_turn_id
         WHERE r.parent_session_id=?1 AND pt.rowid<?2",
        )
        .map_err(StorageError::sqlite)?;
    let mut outbox = db
        .prepare("SELECT result_id FROM btcc_subsession_outbox WHERE relation_id=?1 ORDER BY rowid")
        .map_err(StorageError::sqlite)?;
    let mut turns = Vec::new();
    for parent in waiting {
        let (turn_id, parent_rowid) = parent.map_err(StorageError::sqlite)?;
        let relations =
            parent_relations(&mut own, &mut earlier, session_id, &turn_id, parent_rowid)?;
        if relations.iter().any(|(_, terminal, _)| !terminal) {
            continue;
        }
        let mut last: Option<(i64, String, String)> = None;
        let mut settled = true;
        'relations: for (relation_id, _, relation_parent_rowid) in relations {
            let results = outbox
                .query_map([relation_id], |row| row.get::<_, String>(0))
                .map_err(StorageError::sqlite)?;
            for result in results {
                let result = result.map_err(StorageError::sqlite)?;
                let Some((id, rowid, state)) =
                    result_turn(db, session_id, relation_parent_rowid, &result)?
                else {
                    settled = false;
                    break 'relations;
                };
                if rowid <= parent_rowid {
                    continue;
                }
                if matches!(state.as_str(), "admitted" | "delivery_committed") {
                    settled = false;
                    break 'relations;
                }
                if last.as_ref().is_none_or(|(r, _, _)| rowid > *r) {
                    last = Some((rowid, id, state));
                }
            }
        }
        if settled {
            turns.push(SettledTurn {
                turn_id,
                answer_turn_id: last
                    .filter(|(_, _, state)| state == "delivered")
                    .map(|(_, id, _)| id),
            });
        }
    }
    Ok(turns)
}

fn parent_relations(
    own: &mut Statement<'_>,
    earlier: &mut Statement<'_>,
    session_id: &str,
    turn_id: &str,
    parent_rowid: i64,
) -> StorageResult<Vec<(String, bool, i64)>> {
    let relation = |row: &rusqlite::Row<'_>| -> rusqlite::Result<(String, bool, i64)> {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    };
    let mut relations = own
        .query_map(params![session_id, turn_id], relation)
        .map_err(StorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::sqlite)?;
    if relations.is_empty() {
        relations = earlier
            .query_map(params![session_id, parent_rowid], relation)
            .map_err(StorageError::sqlite)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::sqlite)?;
    }
    Ok(relations)
}

fn result_turn(
    db: &Connection,
    session_id: &str,
    parent_rowid: i64,
    result_id: &str,
) -> StorageResult<Option<(String, i64, String)>> {
    let read_turn = |row: &rusqlite::Row<'_>| Ok((row.get(0)?, row.get(1)?, row.get(2)?));
    let turn = db
        .query_row(
            "SELECT turn_id, rowid, semantic_state FROM btcc_turns
             WHERE turn_id=?1 AND session_id=?2 AND rowid>?3",
            params![worker_result_turn_id(result_id), session_id, parent_rowid],
            read_turn,
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    if turn.is_some() {
        return Ok(turn);
    }
    db.query_row(
        "SELECT turn_id, rowid, semantic_state FROM btcc_turns
         WHERE session_id=?1 AND rowid>?2 AND json_extract(context_json,'$.subsessionResult.result_id')=?3
         ORDER BY rowid LIMIT 1",
        params![session_id, parent_rowid, result_id],
        read_turn,
    )
    .optional()
    .map_err(StorageError::sqlite)
}

pub(in crate::btcc::storage) fn waiting_sessions(
    db: &mut Connection,
) -> StorageResult<Vec<String>> {
    let mut waiting = db
        .prepare(
            "SELECT DISTINCT session_id FROM btcc_turns INDEXED BY idx_btcc_turns_worker_waiting
         WHERE semantic_state='admitted' AND suspension_reason='waiting_for_worker'",
        )
        .map_err(StorageError::sqlite)?;
    waiting
        .query_map([], |row| row.get(0))
        .map_err(StorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::sqlite)
}

pub(in crate::btcc::storage) fn close_settled(
    db: &mut Connection,
    settled: &[SettledTurn],
) -> StorageResult<()> {
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(StorageError::sqlite)?;
    for s in settled {
        let Some(parent) = hydration::find_turn(&tx, &s.turn_id)? else {
            continue;
        };
        if parent.semantic_state != TurnSemanticState::Admitted
            || parent.suspension != Some(SuspensionReason::WaitingForWorker)
        {
            continue;
        }
        if let Some(answer_id) = &s.answer_turn_id {
            let answer = hydration::find_turn(&tx, answer_id)?;
            if let Some(answer) = answer
                && answer.semantic_state == TurnSemanticState::Delivered
                && let (Some(payload), Some(message_id)) = (
                    &answer.final_payload,
                    &answer.canonical_assistant_message_id,
                )
            {
                close_answered_parent(&tx, &s.turn_id, answer_id, payload, message_id)?;
            } else {
                return Err(error(
                    StorageCode::TransitionContention,
                    "BTCC settled answer is not delivered",
                ));
            }
        } else {
            close_unanswered_parent(&tx, &parent)?;
        }
    }
    tx.commit().map_err(StorageError::sqlite)
}

fn close_answered_parent(
    tx: &Transaction<'_>,
    parent_id: &str,
    answer_turn_id: &str,
    answer_payload: &FinalPayload,
    message_id: &str,
) -> StorageResult<()> {
    let Some(parent) = hydration::find_turn(tx, parent_id)? else {
        return Ok(());
    };
    if parent.semantic_state != TurnSemanticState::Admitted
        || parent.suspension != Some(SuspensionReason::WaitingForWorker)
    {
        return Ok(());
    }
    let body = json!({
        "turnId": parent_id,
        "contentSha256": answer_payload.content_sha256,
        "route": answer_payload.route,
        "disposition": "completed",
        "content": answer_payload.content,
        "answeredBy": answer_turn_id
    });
    let reference = content_ref("payload", &body).map_err(|error| {
        StorageError::new(StorageCode::CanonicalJson, error.message()).with_source(error)
    })?;
    let payload = FinalPayload {
        reference,
        turn_id: parent_id.to_owned(),
        ..answer_payload.clone()
    };
    let outbox_id = digest(&format!("btcc-answered-delivery.v1\0{parent_id}"));
    let expected_message_id = digest(&format!("btcc-answered-message.v1\0{parent_id}"));
    let payload_value = serde_json::to_value(&payload).map_err(|error| {
        StorageError::new(StorageCode::InvalidFinalPayload, error.to_string()).with_source(error)
    })?;
    let payload_json = stringify(&payload_value)?;
    records::insert_immutable_record(
        tx,
        &payload.reference.id,
        "final_payload",
        &payload.reference.sha256,
        &payload_json,
    )?;
    let revision = parent.revision + 1;
    tx.execute(
        "INSERT INTO btcc_delivery_outbox (outbox_id, turn_id, committed_turn_revision, payload_id,
             payload_sha256, expected_message_id, content, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'observed')",
        params![outbox_id, parent_id, revision, payload.reference.id, payload.reference.sha256,
            expected_message_id, payload.content],
    ).map_err(StorageError::sqlite)?;
    let changed = tx.execute(
        "UPDATE btcc_turns SET semantic_state='delivered', final_disposition='completed', suspension_reason=NULL,
             active_checkpoint_id=NULL, route=?1, final_payload_json=?2, delivery_outbox_id=?3,
             canonical_assistant_message_id=?4, revision=?5, execution_fence=execution_fence+1
             WHERE turn_id=?6 AND revision=?7 AND semantic_state='admitted' AND suspension_reason='waiting_for_worker'",
        params![route_text(payload.route), payload_json, outbox_id, message_id, revision, parent_id, parent.revision],
    ).map_err(StorageError::sqlite)?;
    if changed != 1 {
        return Err(error(
            StorageCode::TransitionContention,
            "BTCC answered close lost Turn CAS",
        ));
    }
    Ok(())
}

fn close_unanswered_parent(tx: &Transaction<'_>, parent: &TurnRecord) -> StorageResult<()> {
    let changed = tx
        .execute(
            "UPDATE btcc_turns SET semantic_state='cancelled', final_disposition='cancelled', suspension_reason=NULL,
             active_checkpoint_id=NULL, authority_continuation_json=NULL, revision=?1, execution_fence=execution_fence+1
             WHERE turn_id=?2 AND revision=?3 AND semantic_state='admitted' AND suspension_reason='waiting_for_worker'",
            params![parent.revision + 1, parent.turn_id, parent.revision],
        )
        .map_err(StorageError::sqlite)?;
    if changed != 1 {
        return Err(error(
            StorageCode::TransitionContention,
            "BTCC unanswered close lost Turn CAS",
        ));
    }
    tx.execute(
        "UPDATE btcc_checkpoints SET is_active=0, active_claim_id=NULL WHERE turn_id=?1 AND is_active=1",
        [&parent.turn_id],
    )
    .map_err(StorageError::sqlite)?;
    tx.execute(
        "UPDATE btcc_state_claims SET status='revoked' WHERE turn_id=?1 AND status='active'",
        [&parent.turn_id],
    )
    .map_err(StorageError::sqlite)?;
    Ok(())
}
