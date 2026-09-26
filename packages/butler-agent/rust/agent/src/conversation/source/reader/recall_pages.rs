//! Source-order canonical inventory pages for Cognition recall.

use rusqlite::{Connection, OptionalExtension, params};

use crate::conversation::codec::read_message;
use crate::conversation::{ConversationError, ConversationMessageWithParts, ConversationResult};

#[derive(Clone, Debug)]
pub(crate) struct RecallOutcomeRow {
    pub id: String,
    pub session_id: String,
    pub turn_id: String,
    pub generation: f64,
    pub request_message_id: Option<String>,
    pub public_assistant_message_id: Option<String>,
}

fn capped(limit: Option<usize>) -> usize {
    limit.unwrap_or(100).clamp(1, 500)
}

pub(super) fn outcomes(
    db: &Connection,
    after_id: Option<&str>,
    limit: Option<usize>,
) -> ConversationResult<Vec<RecallOutcomeRow>> {
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
    let mut statement=db.prepare(
        "SELECT rowid,id,session_id,turn_id,generation,request_message_id,public_assistant_message_id,
           evidence_refs_json,unresolved_obligations_json,continuation_json
         FROM conversation_turn_outcomes
         WHERE rowid>?1 AND NOT EXISTS (
           SELECT 1 FROM conversation_turn_outcomes newer
           WHERE newer.turn_id=conversation_turn_outcomes.turn_id
             AND (newer.generation>conversation_turn_outcomes.generation OR
               (newer.generation=conversation_turn_outcomes.generation AND newer.rowid>conversation_turn_outcomes.rowid))
         ) ORDER BY rowid ASC LIMIT ?2"
    ).map_err(ConversationError::sqlite)?;
    let rows = statement
        .query_map(params![after_row, capped(limit) as i64], |row| {
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
        })
        .map_err(ConversationError::sqlite)?;
    let mut output = Vec::new();
    for row in rows {
        let (outcome, evidence, unresolved, continuation) =
            row.map_err(ConversationError::sqlite)?;
        // The source reader parses all three JSON columns before returning a row.
        let _: serde_json::Value =
            serde_json::from_str(&evidence).map_err(ConversationError::json)?;
        let _: serde_json::Value =
            serde_json::from_str(&unresolved).map_err(ConversationError::json)?;
        if let Some(continuation) = continuation {
            let _: serde_json::Value =
                serde_json::from_str(&continuation).map_err(ConversationError::json)?;
        }
        output.push(outcome);
    }
    Ok(output)
}

pub(super) fn recovered(
    db: &Connection,
    after_id: Option<&str>,
    limit: Option<usize>,
) -> ConversationResult<Vec<ConversationMessageWithParts>> {
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
        .prepare(
            "SELECT id FROM conversation_messages
         WHERE rowid>?1 AND turn_id IS NULL AND (
           (role='user' AND origin_kind='user_input' AND status IN ('complete','failed','compacted')
             AND provenance IN ('recovered','imported')) OR
           (role='assistant' AND origin_kind='assistant_public' AND status='complete'
             AND provenance='recovered')
         ) ORDER BY rowid LIMIT ?2",
        )
        .map_err(ConversationError::sqlite)?;
    let ids = statement
        .query_map(params![after_row, capped(limit) as i64], |row| {
            row.get::<_, String>(0)
        })
        .map_err(ConversationError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(ConversationError::sqlite)?;
    let mut messages = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(message) = read_message(db, &id)? {
            messages.push(message);
        }
    }
    Ok(messages)
}
