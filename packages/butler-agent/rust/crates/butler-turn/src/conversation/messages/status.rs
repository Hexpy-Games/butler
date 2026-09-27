use std::collections::HashSet;

use rusqlite::Connection;

use crate::conversation::ConversationCode;
use crate::conversation::{
    ConversationError, ConversationMessageStats, ConversationMessageWithParts, ConversationResult,
    codec::read_message,
};

pub(in crate::conversation) fn status_message_facts(
    connection: &Connection,
    session_id: &str,
    tail_limit: u64,
    stale_summary_ids: &[String],
) -> ConversationResult<(ConversationMessageStats, Vec<ConversationMessageWithParts>)> {
    let stale = stale_summary_ids
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let mut statement = connection
        .prepare(
            "SELECT id,compacted_by_summary_id,status,created_at FROM conversation_messages \
             WHERE session_id=?1 ORDER BY seq DESC",
        )
        .map_err(ConversationError::sqlite)?;
    let rows = statement
        .query_map([session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(ConversationError::sqlite)?;
    let tail_limit = usize::try_from(tail_limit).unwrap_or(usize::MAX);
    let mut semantic_messages = 0_u64;
    let mut compacted_messages = 0_u64;
    let mut latest_message_timestamp = None;
    let mut tail_ids = Vec::new();
    for row in rows {
        let (id, summary_id, status, created_at) = row.map_err(ConversationError::sqlite)?;
        if latest_message_timestamp.is_none() {
            latest_message_timestamp = Some(created_at);
        }
        let stale_compaction = summary_id
            .as_deref()
            .is_some_and(|summary_id| stale.contains(summary_id));
        if stale_compaction || (summary_id.is_none() && status != "compacted") {
            semantic_messages = semantic_messages.saturating_add(1);
            if tail_ids.len() < tail_limit {
                tail_ids.push(id);
            }
        } else if summary_id.is_some() || status == "compacted" {
            compacted_messages = compacted_messages.saturating_add(1);
        }
    }
    tail_ids.reverse();
    let semantic_tail = tail_ids
        .iter()
        .map(|id| {
            read_message(connection, id)?.ok_or_else(|| {
                ConversationError::new(
                    ConversationCode::ConversationMessageMissing,
                    "Message disappeared while reading status context",
                )
            })
        })
        .collect::<ConversationResult<Vec<_>>>()?;
    Ok((
        ConversationMessageStats {
            semantic_messages,
            compacted_messages,
            latest_message_timestamp,
        },
        semantic_tail,
    ))
}
