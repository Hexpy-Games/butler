//! The committed source change log that incremental readers follow (see
//! `conversation::source_changes`): the entities changed after a watermark
//! are the rows above it, while the watermark's own row is still present.

use rusqlite::{Connection, OptionalExtension, params};

use crate::conversation::{ConversationCode, ConversationError, ConversationResult};

/// What a source change names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceChangeKind {
    /// A turn or its outcome.
    Turn,
    /// A message or one of its parts.
    Message,
}

/// One logged change.
#[derive(Clone, Debug)]
pub struct SourceChange {
    pub seq: u64,
    pub kind: SourceChangeKind,
    pub entity_id: String,
}

/// A position in the change log: a sequence and the change logged there
/// (`kind:entity_id`; empty at sequence 0, before any change).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceChangeMark {
    pub seq: u64,
    pub key: String,
}

/// The latest committed change; `None` for a store without the log.
pub(super) fn head(db: &Connection) -> ConversationResult<Option<SourceChangeMark>> {
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
    let latest = db
        .query_row(
            "SELECT seq,kind||':'||entity_id FROM conversation_source_changes ORDER BY seq DESC LIMIT 1",
            [],
            |row| Ok(SourceChangeMark { seq: row.get(0)?, key: row.get(1)? }),
        )
        .optional()
        .map_err(ConversationError::sqlite)?;
    Ok(Some(latest.unwrap_or(SourceChangeMark {
        seq: 0,
        key: String::new(),
    })))
}

/// Whether the log still continues from `mark`: its row holds the same
/// change (so no later change was dropped and the store was not replaced
/// by an older copy that has since grown back), or, at sequence 0, the log
/// still starts at its first change.
pub(super) fn holds(db: &Connection, mark: &SourceChangeMark) -> ConversationResult<bool> {
    let held = if mark.seq == 0 {
        db.query_row(
            "SELECT COALESCE((SELECT seq FROM conversation_source_changes ORDER BY seq LIMIT 1),1)=1",
            [],
            |row| row.get(0),
        )
    } else {
        db.query_row(
            "SELECT EXISTS(SELECT 1 FROM conversation_source_changes WHERE seq=?1 AND kind||':'||entity_id=?2)",
            params![mark.seq, mark.key],
            |row| row.get(0),
        )
    };
    held.map_err(ConversationError::sqlite)
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
