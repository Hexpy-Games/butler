//! Source-order canonical inventory pages for Cognition recall.

use rusqlite::{Connection, OptionalExtension, params};

use crate::conversation::codec::read_message;
use crate::conversation::{ConversationError, ConversationMessageWithParts, ConversationResult};

/// A turn outcome row for recall.
#[derive(Clone, Debug)]
pub struct RecallOutcomeRow {
    pub id: String,
    pub session_id: String,
    pub turn_id: String,
    pub generation: f64,
    pub request_message_id: Option<String>,
    pub public_assistant_message_id: Option<String>,
}

/// A page row of turn outcomes: its identity, and the row unless its JSON
/// columns do not parse.
#[derive(Debug)]
pub struct RecallOutcomeEntry {
    pub id: String,
    pub session_id: String,
    pub turn_id: String,
    pub row: ConversationResult<RecallOutcomeRow>,
}

fn capped(limit: Option<usize>) -> usize {
    limit.unwrap_or(100).clamp(1, 500)
}

/// The latest outcome of each turn: no other outcome of the turn has a
/// higher generation, or the same generation and a later row.
const LATEST_OUTCOME: &str = "SELECT rowid,id,session_id,turn_id,generation,request_message_id,
      public_assistant_message_id,evidence_refs_json,unresolved_obligations_json,continuation_json
    FROM conversation_turn_outcomes
    WHERE NOT EXISTS (
      SELECT 1 FROM conversation_turn_outcomes newer
      WHERE newer.turn_id=conversation_turn_outcomes.turn_id
        AND (newer.generation>conversation_turn_outcomes.generation OR
          (newer.generation=conversation_turn_outcomes.generation AND newer.rowid>conversation_turn_outcomes.rowid))
    )";

pub(super) fn outcomes(
    db: &Connection,
    after_id: Option<&str>,
    limit: Option<usize>,
) -> ConversationResult<Vec<RecallOutcomeRow>> {
    outcome_entries(db, after_id, limit)?
        .into_iter()
        .map(|entry| entry.row)
        .collect()
}

pub(super) fn outcome_entries(
    db: &Connection,
    after_id: Option<&str>,
    limit: Option<usize>,
) -> ConversationResult<Vec<RecallOutcomeEntry>> {
    let after_row = match after_id {
        Some(id) => db
            .query_row(
                "SELECT rowid FROM conversation_turn_outcomes WHERE id=?1",
                [id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(ConversationError::sqlite)?
            .unwrap_or(0),
        None => 0,
    };
    latest_outcomes(
        db,
        &format!("{LATEST_OUTCOME} AND rowid>?1 ORDER BY rowid ASC LIMIT ?2"),
        params![after_row, i64::try_from(capped(limit)).unwrap_or(i64::MAX)],
    )
}

/// The latest outcome of one turn, as [`outcomes`] pages it.
pub(super) fn turn_outcome(
    db: &Connection,
    turn_id: &str,
) -> ConversationResult<Option<RecallOutcomeRow>> {
    latest_outcomes(
        db,
        &format!("{LATEST_OUTCOME} AND turn_id=?1 ORDER BY rowid ASC"),
        params![turn_id],
    )?
    .pop()
    .map(|entry| entry.row)
    .transpose()
}

fn latest_outcomes(
    db: &Connection,
    sql: &str,
    params: impl rusqlite::Params,
) -> ConversationResult<Vec<RecallOutcomeEntry>> {
    let mut statement = db.prepare(sql).map_err(ConversationError::sqlite)?;
    let rows = statement
        .query_map(params, |row| {
            // A column of the wrong type fails only its own row.
            let decoded = (|| {
                Ok((
                    RecallOutcomeRow {
                        id: row.get(1)?,
                        session_id: row.get(2)?,
                        turn_id: row.get(3)?,
                        generation: row.get(4)?,
                        request_message_id: row.get(5)?,
                        public_assistant_message_id: row.get(6)?,
                    },
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, Option<String>>(9)?,
                ))
            })();
            Ok((
                [
                    lossy(row.get_ref(1)?),
                    lossy(row.get_ref(2)?),
                    lossy(row.get_ref(3)?),
                ],
                decoded,
            ))
        })
        .map_err(ConversationError::sqlite)?;
    let mut output = Vec::new();
    for row in rows {
        let ([id, session_id, turn_id], decoded) = row.map_err(ConversationError::sqlite)?;
        let row = decoded.map_err(ConversationError::sqlite).and_then(
            |(outcome, evidence, unresolved, continuation)| {
                parsed(&evidence, &unresolved, continuation.as_deref()).map(|()| outcome)
            },
        );
        output.push(RecallOutcomeEntry {
            id,
            session_id,
            turn_id,
            row,
        });
    }
    Ok(output)
}

/// A column's text for naming a row whose values do not decode.
fn lossy(value: rusqlite::types::ValueRef<'_>) -> String {
    use rusqlite::types::ValueRef;
    match value {
        ValueRef::Text(text) => String::from_utf8_lossy(text).into_owned(),
        ValueRef::Integer(number) => number.to_string(),
        ValueRef::Real(number) => number.to_string(),
        ValueRef::Null | ValueRef::Blob(_) => String::new(),
    }
}

/// The source reader parses all three JSON columns before returning a row.
fn parsed(evidence: &str, unresolved: &str, continuation: Option<&str>) -> ConversationResult<()> {
    for text in [Some(evidence), Some(unresolved), continuation]
        .into_iter()
        .flatten()
    {
        let _: serde_json::Value = serde_json::from_str(text).map_err(ConversationError::json)?;
    }
    Ok(())
}

pub(super) fn recovered(
    db: &Connection,
    after_id: Option<&str>,
    limit: Option<usize>,
) -> ConversationResult<Vec<ConversationMessageWithParts>> {
    let ids = recovered_ids(db, after_id, limit)?;
    let mut messages = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(message) = read_message(db, &id)? {
            messages.push(message);
        }
    }
    Ok(messages)
}

pub(super) fn recovered_ids(
    db: &Connection,
    after_id: Option<&str>,
    limit: Option<usize>,
) -> ConversationResult<Vec<String>> {
    let after_row = match after_id {
        Some(id) => db
            .query_row(
                "SELECT rowid FROM conversation_messages WHERE id=?1",
                [id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(ConversationError::sqlite)?
            .unwrap_or(0),
        None => 0,
    };
    let mut statement = db
        .prepare(&format!(
            "SELECT id FROM conversation_messages WHERE rowid>?1 AND {RECOVERED} ORDER BY rowid LIMIT ?2"
        ))
        .map_err(ConversationError::sqlite)?;
    let ids = statement
        .query_map(
            params![after_row, i64::try_from(capped(limit)).unwrap_or(i64::MAX)],
            |row| row.get::<_, String>(0),
        )
        .map_err(ConversationError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(ConversationError::sqlite)?;
    Ok(ids)
}

/// Standalone messages that recall reads as recovered sources.
const RECOVERED: &str = "turn_id IS NULL AND (
    (role='user' AND origin_kind='user_input' AND status IN ('complete','failed','compacted')
      AND provenance IN ('recovered','imported')) OR
    (role='assistant' AND origin_kind='assistant_public' AND status='complete'
      AND provenance='recovered'))";

/// One message when it is a recovered source, as [`recovered`] pages it.
pub(super) fn recovered_one(
    db: &Connection,
    message_id: &str,
) -> ConversationResult<Option<ConversationMessageWithParts>> {
    let id = db
        .query_row(
            &format!("SELECT id FROM conversation_messages WHERE id=?1 AND {RECOVERED}"),
            [message_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(ConversationError::sqlite)?;
    id.map(|id| read_message(db, &id))
        .transpose()
        .map(Option::flatten)
}
