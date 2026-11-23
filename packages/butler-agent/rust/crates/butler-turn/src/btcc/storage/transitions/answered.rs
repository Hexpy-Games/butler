use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::json;

use super::records;
use crate::btcc::StorageCode;
use crate::btcc::identity::{content_ref, digest};
use crate::btcc::storage::common::{error, route_text, stringify};
use crate::btcc::storage::{StorageError, StorageResult, hydration};
use crate::btcc::turn::{FinalPayload, SuspensionReason, TurnSemanticState};

pub(in crate::btcc::storage) fn answered_turns(
    db: &mut Connection,
    answer_turn_id: &str,
) -> StorageResult<Vec<String>> {
    let answer = db
        .query_row(
            "SELECT rowid, session_id, semantic_state,
                    json_extract(context_json,'$.subsessionResult.result_id')
             FROM btcc_turns WHERE turn_id=?1",
            [answer_turn_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    let Some((rowid, session_id, state, Some(mut result_id))) = answer else {
        return Ok(vec![]);
    };
    if state != "delivered" {
        return Ok(vec![]);
    }

    let mut waiting = db.prepare(
        "SELECT t.turn_id FROM btcc_turns t INDEXED BY idx_btcc_turns_worker_waiting
         WHERE t.session_id=?1 AND t.semantic_state='admitted' AND t.suspension_reason='waiting_for_worker'
           AND t.rowid<?2 AND NOT EXISTS (SELECT 1 FROM btcc_session_relations r
             WHERE r.parent_session_id=?1 AND r.parent_turn_id=t.turn_id)",
    ).map_err(StorageError::sqlite)?;
    let mut parents = waiting
        .query_map(params![session_id, rowid], |row| row.get::<_, String>(0))
        .map_err(StorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::sqlite)?;

    loop {
        let outbox = db.query_row(
            "SELECT rowid, parent_session_id, parent_turn_id FROM btcc_subsession_outbox WHERE result_id=?1",
            [&result_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
        ).optional().map_err(StorageError::sqlite)?;
        let Some((outbox_rowid, parent_session_id, parent)) = outbox else {
            break;
        };
        let closeable: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM btcc_turns WHERE turn_id=?1 AND semantic_state='admitted'
                           AND suspension_reason='waiting_for_worker')
                AND NOT EXISTS(SELECT 1 FROM btcc_session_relations r
                    WHERE r.parent_session_id=?2 AND r.parent_turn_id=?1 AND NOT EXISTS(
                        SELECT 1 FROM btcc_subsession_outbox x
                        WHERE x.relation_id=r.relation_id AND x.rowid<=?3))",
            params![parent, parent_session_id, outbox_rowid],
            |row| row.get(0),
        ).map_err(StorageError::sqlite)?;
        if !closeable || parents.contains(&parent) {
            break;
        }
        parents.push(parent.clone());
        let next: Option<String> = db.query_row(
            "SELECT json_extract(context_json,'$.subsessionResult.result_id') FROM btcc_turns WHERE turn_id=?1",
            [parent],
            |row| row.get(0),
        ).map_err(StorageError::sqlite)?;
        let Some(next) = next else { break };
        result_id = next;
    }
    Ok(parents)
}

pub(in crate::btcc::storage) fn close_answered(
    db: &mut Connection,
    parents: &[String],
    answer_turn_id: &str,
) -> StorageResult<()> {
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(StorageError::sqlite)?;
    let Some(answer) = hydration::find_turn(&tx, answer_turn_id)? else {
        return Ok(());
    };
    let (Some(answer_payload), Some(message_id)) = (
        answer.final_payload.as_ref(),
        answer.canonical_assistant_message_id.as_ref(),
    ) else {
        return Ok(());
    };
    if answer.semantic_state != TurnSemanticState::Delivered {
        return Ok(());
    }

    for parent_id in parents {
        close_answered_parent(&tx, parent_id, answer_turn_id, answer_payload, message_id)?;
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

pub(in crate::btcc::storage) fn recovery_answers(
    db: &mut Connection,
) -> StorageResult<Vec<String>> {
    let mut waiting = db.prepare(
        "SELECT turn_id, session_id, rowid FROM btcc_turns INDEXED BY idx_btcc_turns_worker_waiting
         WHERE semantic_state='admitted' AND suspension_reason='waiting_for_worker'",
    ).map_err(StorageError::sqlite)?;
    let rows = waiting
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(StorageError::sqlite)?;
    let mut answers = Vec::new();
    for row in rows {
        let (turn_id, session_id, rowid) = row.map_err(StorageError::sqlite)?;
        let has_relations = db.query_row(
            "SELECT 1 FROM btcc_session_relations WHERE parent_session_id=?1 AND parent_turn_id=?2 LIMIT 1",
            params![session_id, turn_id],
            |_| Ok(()),
        ).optional().map_err(StorageError::sqlite)?.is_some();
        let answer: Option<String> = if has_relations {
            let missing_result: bool = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM btcc_session_relations r
                    WHERE r.parent_session_id=?1 AND r.parent_turn_id=?2 AND NOT EXISTS(
                        SELECT 1 FROM btcc_subsession_outbox x WHERE x.relation_id=r.relation_id))",
                params![session_id, turn_id],
                |row| row.get(0),
            ).map_err(StorageError::sqlite)?;
            if missing_result {
                continue;
            }
            db.query_row(
                "SELECT t.turn_id FROM btcc_turns t WHERE t.session_id=?1 AND t.rowid>?2 AND t.semantic_state='delivered'
                   AND json_extract(t.context_json,'$.subsessionResult.result_id') IN
                     (SELECT x.result_id FROM btcc_subsession_outbox x JOIN btcc_session_relations r USING(relation_id)
                      WHERE r.parent_session_id=?1 AND r.parent_turn_id=?3)
                 ORDER BY t.rowid DESC LIMIT 1",
                params![session_id, rowid, turn_id],
                |row| row.get(0),
            )
        } else {
            db.query_row(
                "SELECT t.turn_id FROM btcc_turns t WHERE t.session_id=?1 AND t.rowid>?2 AND t.semantic_state='delivered'
                   AND json_extract(t.context_json,'$.subsessionResult.result_id') IS NOT NULL
                 ORDER BY t.rowid ASC LIMIT 1",
                params![session_id, rowid],
                |row| row.get(0),
            )
        }.optional().map_err(StorageError::sqlite)?;
        if let Some(answer) = answer
            && !answers.contains(&answer)
        {
            answers.push(answer);
        }
    }
    Ok(answers)
}
