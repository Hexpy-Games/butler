//! New registry statements kept separate so deployed authority plans stay stable.
use super::query::{ROW, many, sql};
use crate::btcc::authority::contracts::{AuthorityRecord, AuthorityResult};
use rusqlite::Connection;

pub(crate) const GLOBAL_FILTER: &str = "close_reason IS NULL AND (decision='pending' OR (capability='ask_user' AND decision='modified' AND outcome_receipt_json IS NULL AND json_extract(CASE WHEN capability='ask_user' THEN private_alternative_input END,'$.status')='deferred'))";
pub(crate) fn global_sql(cursor: bool) -> String {
    format!(
        "{ROW} INDEXED BY idx_btcc_authority_open_v2 WHERE {GLOBAL_FILTER} {} \
      AND ((decision='pending' AND source_call_id IS NOT NULL AND EXISTS \
        (SELECT 1 FROM btcc_turns t WHERE t.turn_id=source_turn_id AND t.suspension_reason='authority_pending')) \
      OR (capability='ask_user' AND decision='modified' AND json_extract(private_alternative_input,'$.status')='deferred')) \
      ORDER BY created_at DESC, (CASE WHEN capability='ask_user' THEN 'question:' ELSE 'approval:' END)||request_ref DESC LIMIT ?1",
        if cursor {
            "AND created_at<=?2 AND (created_at<?2 OR (CASE WHEN capability='ask_user' THEN 'question:' ELSE 'approval:' END)||request_ref<?3)"
        } else {
            ""
        }
    )
}

pub(super) fn global(
    db: &Connection,
    limit: usize,
    before: Option<&str>,
) -> AuthorityResult<Vec<AuthorityRecord>> {
    let limit = i64::try_from(limit).unwrap_or(i64::MAX);
    match before {
        Some(before) => {
            let (time, id) = before.split_once('|').ok_or_else(|| {
                crate::btcc::authority::contracts::AuthorityError::policy("invalid_cursor")
            })?;
            many(db, &global_sql(true), &[&limit, &time, &id])
        }
        None => many(db, &global_sql(false), &[&limit]),
    }
}

pub(crate) const CHANGES: &str = "SELECT seq,owner,request_ref,kind,state FROM agent_pending_ask_changes WHERE seq>?1 ORDER BY seq LIMIT 128";
pub(crate) const ACK: &str = "DELETE FROM agent_pending_ask_changes WHERE seq<=?1";
pub(crate) const DISMISS: &str = "UPDATE btcc_authority_requests SET outcome_receipt_json=?3,outcome='applied',updated_at=?4 WHERE request_ref=?1 AND owner_session_id=?2 AND capability='ask_user' AND decision='modified' AND close_reason IS NULL AND outcome_receipt_json IS NULL AND json_extract(private_alternative_input,'$.status')='deferred'";

pub(super) fn changes(
    db: &Connection,
    after: i64,
) -> AuthorityResult<Vec<crate::btcc::PendingAskChange>> {
    db.prepare_cached(CHANGES)
        .map_err(sql)?
        .query_map([after], |r| {
            Ok(crate::btcc::PendingAskChange {
                seq: r.get(0)?,
                owner: r.get(1)?,
                request_ref: r.get(2)?,
                kind: r.get(3)?,
                state: r.get(4)?,
            })
        })
        .map_err(sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql)
}

pub(crate) const CLOSE_QUESTIONS: &str = "UPDATE btcc_authority_requests INDEXED BY idx_btcc_questions_deferred SET outcome_receipt_json=?2,outcome='applied',updated_at=?3 WHERE owner_session_id=?1 AND capability='ask_user' AND decision='modified' AND close_reason IS NULL AND outcome_receipt_json IS NULL AND json_extract(CASE WHEN capability='ask_user' THEN private_alternative_input END,'$.status')='deferred'";

/// One per-turn read. Open rows use the deployed session projection unchanged.
pub(crate) fn reminder_sql() -> String {
    format!(
        "{} \
        UNION ALL {ROW} INDEXED BY idx_btcc_questions_settled \
        WHERE owner_session_id=?1 AND capability='ask_user' AND outcome_receipt_json IS NOT NULL \
        AND updated_at > COALESCE((SELECT created_at FROM btcc_messages WHERE message_id=( \
            SELECT original_message_id FROM btcc_turns INDEXED BY idx_btcc_turns_session \
            WHERE session_id=?1 AND rowid<(SELECT rowid FROM btcc_turns WHERE turn_id=?2) \
            AND canonical_assistant_message_id IS NOT NULL ORDER BY rowid DESC LIMIT 1)), '') \
        AND close_reason IS NULL AND decision='modified' \
        AND json_extract(private_alternative_input,'$.status')='deferred' \
        AND json_extract(outcome_receipt_json,'$.status')='answered'",
        super::query::deferred_sql()
    )
}
