use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

use super::db_error;
use crate::cognition::{CognitionError, CognitionResult, lexical};

pub(super) fn index_source(
    connection: &Connection,
    source_id: &str,
    text: &str,
) -> CognitionResult<()> {
    let source = connection
        .query_row(
            "SELECT byte_start,byte_end FROM memory_chunk_sources WHERE source_id=?1",
            [source_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(db_error)?;
    if source.is_none_or(|(start, end)| end - start != text.len() as i64) {
        return Err(CognitionError::new(
            "memory_source_index_span_mismatch",
            "memory_source_index_span_mismatch",
        ));
    }
    let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
    let existing = connection
        .query_row(
            "SELECT text_hash FROM memory_source_text WHERE source_id=?1",
            [source_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?;
    if let Some(existing) = existing {
        return if existing == hash {
            Ok(())
        } else {
            Err(CognitionError::new(
                "memory_source_index_changed",
                "memory_source_index_changed",
            ))
        };
    }
    connection
        .execute(
            "INSERT INTO memory_source_text(source_id,text,text_hash) VALUES(?1,?2,?3)",
            params![source_id, text, hash],
        )
        .map_err(db_error)?;
    let source_key = connection.last_insert_rowid();
    let folded = lexical::case_fold(text);
    let mut insert = connection
        .prepare("INSERT INTO memory_source_terms(term,source_key) VALUES(?1,?2)")
        .map_err(db_error)?;
    for term in lexical::terms(&folded) {
        if !crate::public_text::trim_js_whitespace(&term).is_empty() {
            insert
                .execute(params![term, source_key])
                .map_err(db_error)?;
        }
    }
    Ok(())
}
