//! The committed source change sequence that incremental readers follow.
//!
//! Store triggers move each written turn or message (with its outcome or
//! parts) to the end of the sequence, so the entities changed after a
//! watermark are exactly the rows above it.

use rusqlite::{Connection, params};

use crate::conversation::{ConversationCode, ConversationError, ConversationResult};

/// What a source change names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceChangeKind {
    /// A turn or its outcome.
    Turn,
    /// A message or one of its parts.
    Message,
}

/// One entity's latest change.
#[derive(Clone, Debug)]
pub struct SourceChange {
    pub seq: u64,
    pub kind: SourceChangeKind,
    pub entity_id: String,
}

/// The highest committed change; `None` for a store without the sequence.
pub(super) fn head(db: &Connection) -> ConversationResult<Option<u64>> {
    let tracked: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_source_changes')",
            [],
            |row| row.get(0),
        )
        .map_err(ConversationError::sqlite)?;
    if !tracked {
        return Ok(None);
    }
    db.query_row(
        "SELECT COALESCE(MAX(seq),0) FROM conversation_source_changes",
        [],
        |row| row.get(0),
    )
    .map(Some)
    .map_err(ConversationError::sqlite)
}

/// Up to `limit` changes after `after`, in commit order.
pub(super) fn after(
    db: &Connection,
    after: u64,
    limit: usize,
) -> ConversationResult<Vec<SourceChange>> {
    let mut statement = db
        .prepare(
            "SELECT seq,kind,entity_id FROM conversation_source_changes WHERE seq>?1 ORDER BY seq LIMIT ?2",
        )
        .map_err(ConversationError::sqlite)?;
    let rows = statement
        .query_map(
            params![after, i64::try_from(limit).unwrap_or(i64::MAX)],
            |row| {
                Ok((
                    row.get::<_, u64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .map_err(ConversationError::sqlite)?;
    let mut changes = Vec::new();
    for row in rows {
        let (seq, kind, entity_id) = row.map_err(ConversationError::sqlite)?;
        let kind = match kind.as_str() {
            "turn" => SourceChangeKind::Turn,
            "message" => SourceChangeKind::Message,
            _ => {
                return Err(ConversationError::new(
                    ConversationCode::ConversationSourceSchemaUnavailable,
                    format!("Unknown source change kind {kind}"),
                ));
            }
        };
        changes.push(SourceChange {
            seq,
            kind,
            entity_id,
        });
    }
    Ok(changes)
}
