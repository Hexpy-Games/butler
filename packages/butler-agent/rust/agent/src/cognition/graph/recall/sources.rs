//! Named active/split-parent source rows for canonical hydration.

use rusqlite::{Connection, OptionalExtension};

use crate::cognition::{CognitionResult, CognitionSourceRow};

use super::db_error;

pub(super) fn rows(
    db: &Connection,
    source_ids: &[String],
) -> CognitionResult<Vec<CognitionSourceRow>> {
    let mut statement = db
        .prepare(
            "SELECT source_id,episode_id,revision,source_kind,conversation_session_id,
          conversation_message_id,part_id,scalar_pointer,byte_start,byte_end,content_hash,
          role,origin_kind,observed_at,basis
         FROM memory_chunk_sources WHERE source_id=?1
         UNION ALL
         SELECT source_id,episode_id,revision,source_kind,conversation_session_id,
          conversation_message_id,part_id,scalar_pointer,byte_start,byte_end,content_hash,
          role,origin_kind,observed_at,basis
         FROM memory_source_split_parents WHERE source_id=?1 LIMIT 1",
        )
        .map_err(db_error)?;
    let mut output = Vec::with_capacity(source_ids.len());
    for source_id in source_ids {
        if let Some(row) = statement
            .query_row([source_id], |row| {
                Ok(CognitionSourceRow {
                    source_id: row.get(0)?,
                    episode_id: row.get(1)?,
                    revision: row.get(2)?,
                    source_kind: row.get(3)?,
                    conversation_session_id: row.get(4)?,
                    conversation_message_id: row.get(5)?,
                    part_id: row.get(6)?,
                    scalar_pointer: row.get(7)?,
                    byte_start: row.get(8)?,
                    byte_end: row.get(9)?,
                    content_hash: row.get(10)?,
                    role: row.get(11)?,
                    origin_kind: row.get(12)?,
                    observed_at: row.get(13)?,
                    basis: row.get(14)?,
                })
            })
            .optional()
            .map_err(db_error)?
        {
            output.push(row);
        }
    }
    Ok(output)
}

pub(super) fn project_id(db: &Connection, episode_id: &str) -> CognitionResult<Option<String>> {
    db.query_row(
        "SELECT project_id FROM memory_chunks WHERE memory_chunk_id=?1",
        [episode_id],
        |row| row.get(0),
    )
    .optional()
    .map(|value| value.flatten())
    .map_err(db_error)
}
