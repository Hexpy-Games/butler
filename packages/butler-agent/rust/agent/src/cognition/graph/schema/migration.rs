use rusqlite::{Connection, OptionalExtension};

use super::super::db_error;
use crate::cognition::CognitionResult;

pub(super) fn nullable_source_ids(connection: &mut Connection) -> CognitionResult<()> {
    if !connection.is_autocommit() {
        return Ok(());
    }
    let sources = needs_migration(connection, "memory_chunk_sources")?;
    let parents = needs_migration(connection, "memory_source_split_parents")?;
    if !sources && !parents {
        return Ok(());
    }
    connection
        .execute_batch("PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON")
        .map_err(db_error)?;
    let migrated = (|| {
        let tx = connection.transaction().map_err(db_error)?;
        if sources {
            tx.execute_batch(SOURCES).map_err(db_error)?;
        }
        if parents {
            tx.execute_batch(PARENTS).map_err(db_error)?;
        }
        tx.commit().map_err(db_error)
    })();
    let restore = connection
        .execute_batch("PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON")
        .map_err(db_error);
    migrated.and(restore)
}

pub(super) fn legacy_failures(connection: &mut Connection, now: &str) -> CognitionResult<()> {
    let found = connection
        .query_row(
            "SELECT value FROM memory_state WHERE key='t3_legacy_failure_migration'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?;
    if found.is_some() {
        return Ok(());
    }
    let tx = connection.transaction().map_err(db_error)?;
    tx.execute("UPDATE memory_projection_windows SET attempt_count=1 WHERE state='failed' AND attempt_count=0 AND input_json IS NULL AND input_migration_note IS NULL AND normalized_plan_json IS NULL", []).map_err(db_error)?;
    tx.execute("INSERT OR IGNORE INTO memory_projection_attempts(attempt_ref,window_ref,job_id,attempt_count,state,error_code,input_sha256,output_json,provider_evidence_json,recorded_at,attempt_kind,provider_invoked,outcome_known) SELECT window_ref || ':attempt:1:failed',window_ref,job_id,1,'failed',error_code,input_sha256,output_json,provider_evidence_json,COALESCE(started_at,?1),'legacy',1,1 FROM memory_projection_windows WHERE state='failed' AND attempt_count=1 AND input_json IS NULL AND input_migration_note IS NULL AND normalized_plan_json IS NULL", [now]).map_err(db_error)?;
    tx.execute("UPDATE memory_projection_windows SET state='pending',next_attempt_at=?1,input_migration_note='legacy_input_unavailable' WHERE state='failed' AND attempt_count=1 AND input_json IS NULL AND input_migration_note IS NULL AND normalized_plan_json IS NULL", [now]).map_err(db_error)?;
    tx.execute(
        "INSERT INTO memory_state(key,value) VALUES('t3_legacy_failure_migration',?1)",
        [now],
    )
    .map_err(db_error)?;
    tx.commit().map_err(db_error)
}

fn needs_migration(connection: &Connection, table: &str) -> CognitionResult<bool> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>("name")?, row.get::<_, i64>("notnull")?))
        })
        .map_err(db_error)?;
    for row in rows {
        let (name, notnull) = row.map_err(db_error)?;
        if matches!(
            name.as_str(),
            "conversation_session_id" | "conversation_message_id"
        ) && notnull == 1
        {
            return Ok(true);
        }
    }
    Ok(false)
}

const SOURCES: &str = "DROP INDEX IF EXISTS idx_sources_message_revision; ALTER TABLE memory_chunk_sources RENAME TO memory_chunk_sources_pre_t5a; CREATE TABLE memory_chunk_sources(source_id TEXT PRIMARY KEY,episode_id TEXT NOT NULL REFERENCES memory_chunks(memory_chunk_id),revision TEXT NOT NULL,source_kind TEXT NOT NULL,conversation_session_id TEXT,conversation_message_id TEXT,part_id TEXT NOT NULL,scalar_pointer TEXT NOT NULL,byte_start INTEGER NOT NULL,byte_end INTEGER NOT NULL,content_hash TEXT NOT NULL,role TEXT NOT NULL,origin_kind TEXT NOT NULL,observed_at TEXT NOT NULL,basis TEXT NOT NULL,UNIQUE(episode_id,revision,conversation_message_id,part_id,scalar_pointer,byte_start,byte_end)); INSERT INTO memory_chunk_sources SELECT * FROM memory_chunk_sources_pre_t5a; DROP TABLE memory_chunk_sources_pre_t5a;";
const PARENTS: &str = "ALTER TABLE memory_source_split_parents RENAME TO memory_source_split_parents_pre_t5a; CREATE TABLE memory_source_split_parents(source_id TEXT PRIMARY KEY,episode_id TEXT NOT NULL,revision TEXT NOT NULL,source_kind TEXT NOT NULL,conversation_session_id TEXT,conversation_message_id TEXT,part_id TEXT NOT NULL,scalar_pointer TEXT NOT NULL,byte_start INTEGER NOT NULL,byte_end INTEGER NOT NULL,content_hash TEXT NOT NULL,role TEXT NOT NULL,origin_kind TEXT NOT NULL,observed_at TEXT NOT NULL,basis TEXT NOT NULL,child_source_ids_json TEXT NOT NULL,recorded_at TEXT NOT NULL); INSERT INTO memory_source_split_parents SELECT * FROM memory_source_split_parents_pre_t5a; DROP TABLE memory_source_split_parents_pre_t5a;";
