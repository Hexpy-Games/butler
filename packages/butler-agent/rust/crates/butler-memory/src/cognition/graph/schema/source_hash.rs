//! One-time, resumable repair of standalone source hashes in existing graphs.
//! Each recovery lease visits at most 64 chunks through the unique source-key
//! index. The cursor and repaired rows commit together; idle probes read only
//! the completion marker. Canonical revisions must match before metadata changes.

use butler_turn::conversation::ConversationSourceReader;
use rusqlite::{Connection, OptionalExtension, params};

use super::super::{GraphRepository, db_error};
use crate::cognition::{
    CognitionResult, ConversationSourceNotice, PreparedConversationSource,
    prepare_conversation_source, sources::recovered_parts_hash,
};

const COMPLETE: &str = "standalone_hash_repair_complete";
const CURSOR: &str = "standalone_hash_repair_cursor";
const PAGE: usize = 64;

impl GraphRepository {
    /// Runs one bounded schema-data repair quantum under the recovery lease.
    pub(in crate::cognition) fn repair_standalone_hashes(
        &mut self,
        canonical: &ConversationSourceReader,
        now: &str,
    ) -> CognitionResult<bool> {
        let db = self.connection_mut()?;
        if read_state(db, COMPLETE)?.is_some() {
            return Ok(false);
        }
        let tx = db.transaction().map_err(db_error)?;
        let cursor = read_state(&tx, CURSOR)?.unwrap_or_else(|| "conversation_message:".into());
        let rows = read_page(&tx, &cursor)?;
        for row in &rows {
            repair_row(&tx, canonical, row, now)?;
        }
        if rows.len() < PAGE {
            tx.execute(
                "INSERT INTO memory_state(key,value) VALUES(?1,?2)",
                [COMPLETE, now],
            )
            .map_err(db_error)?;
            tx.execute("DELETE FROM memory_state WHERE key=?1", [CURSOR])
                .map_err(db_error)?;
        } else if let Some((key, ..)) = rows.last() {
            tx.execute("INSERT INTO memory_state(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [CURSOR, key]).map_err(db_error)?;
        }
        tx.commit().map_err(db_error)?;
        Ok(true)
    }

    /// Also repairs a same-revision mismatch encountered after the migration.
    pub(in crate::cognition) fn refresh_conversation_source_hash(
        &self,
        canonical: &ConversationSourceReader,
        notice: ConversationSourceNotice<'_>,
        revision: &str,
        now: &str,
    ) -> CognitionResult<()> {
        refresh(self.connection()?, canonical, notice, revision, now)
    }
}

fn refresh(
    db: &Connection,
    canonical: &ConversationSourceReader,
    notice: ConversationSourceNotice<'_>,
    revision: &str,
    now: &str,
) -> CognitionResult<()> {
    if let PreparedConversationSource::Plan(plan) =
        prepare_conversation_source(canonical, notice, now)?
        && plan.revision == revision
    {
        db.execute(
            "UPDATE memory_chunks SET source_hash=?1,updated_at=?2 WHERE source_key=?3 AND current_revision=?4 AND source_hash<>?1",
            params![plan.source_hash, now, plan.source_key, revision],
        ).map_err(db_error)?;
    }
    Ok(())
}

fn read_state(db: &Connection, key: &str) -> CognitionResult<Option<String>> {
    db.query_row(
        "SELECT value FROM memory_state WHERE key=?1",
        [key],
        |row| row.get(0),
    )
    .optional()
    .map_err(db_error)
}

type RepairRow = (String, String, Option<String>);

fn read_page(db: &Connection, cursor: &str) -> CognitionResult<Vec<RepairRow>> {
    db.prepare(
        "SELECT c.source_key,c.current_revision,\
             (SELECT extraction_version FROM memory_projection_jobs j \
              WHERE j.episode_id=c.memory_chunk_id AND j.revision=c.current_revision \
              ORDER BY extraction_version LIMIT 1) \
             FROM memory_chunks c WHERE c.source_key>?1 AND c.source_key<'conversation_message;' \
             ORDER BY c.source_key LIMIT ?2",
    )
    .map_err(db_error)?
    .query_map(params![cursor, PAGE], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
        ))
    })
    .map_err(db_error)?
    .collect::<Result<Vec<_>, _>>()
    .map_err(db_error)
}

fn repair_row(
    db: &Connection,
    canonical: &ConversationSourceReader,
    row: &RepairRow,
    now: &str,
) -> CognitionResult<()> {
    let (key, revision, version) = row;
    let Some(version) = version else {
        return Ok(());
    };
    let Some(id) = key.strip_prefix("conversation_message:") else {
        return Ok(());
    };
    let Some(message) = canonical.read_message(id)? else {
        return Ok(());
    };
    let hash = recovered_parts_hash(&message)?;
    let notice = ConversationSourceNotice::Standalone {
        session_id: &message.message.session_id,
        message_id: id,
        source_hash: &hash,
        extraction_version: version,
    };
    match refresh(db, canonical, notice, revision, now) {
        // Catch-up handles sources whose canonical eligibility changed.
        Err(error)
            if matches!(
                error.code(),
                "memory_source_not_terminal"
                    | "memory_source_ineligible"
                    | "memory_source_text_missing"
            ) => {}
        result => result?,
    }
    Ok(())
}
