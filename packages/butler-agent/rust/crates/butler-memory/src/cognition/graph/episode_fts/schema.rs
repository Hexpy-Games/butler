//! Install only on the background consolidation work path; seed resumable work.
use super::super::db_error;
use crate::cognition::CognitionResult;
use rusqlite::Connection;

pub(in crate::cognition::graph) fn install(db: &Connection) -> CognitionResult<()> {
    db.execute_batch(SCHEMA).map_err(db_error)?;
    for table in [
        "memory_chunks",
        "memory_chunk_sources",
        "memory_source_text",
        "memory_evidence",
        "memory_aliases",
        "memory_claims",
    ] {
        for event in ["INSERT", "UPDATE", "DELETE"] {
            if table == "memory_chunks" && event == "DELETE" {
                continue;
            }
            let rows = match event {
                "UPDATE" => vec!["OLD", "NEW"],
                "DELETE" => vec!["OLD"],
                _ => vec!["NEW"],
            };
            let select = rows.into_iter().map(|row| match table {
                "memory_chunks" => format!("SELECT {row}.memory_chunk_id"),
                "memory_chunk_sources" | "memory_evidence" => format!("SELECT {row}.episode_id"),
                "memory_claims" => format!("SELECT episode_id FROM memory_evidence WHERE node_id={row}.node_id"),
                _ => format!("SELECT episode_id FROM memory_chunk_sources WHERE source_id={row}.source_id"),
            }).collect::<Vec<_>>().join(" UNION ");
            db.execute_batch(&format!("CREATE TRIGGER IF NOT EXISTS fts_v1_{table}_{event} AFTER {event} ON {table} BEGIN INSERT OR IGNORE INTO memory_episode_fts_pending {select}; END;")).map_err(db_error)?;
        }
    }
    db.execute_batch("CREATE TRIGGER IF NOT EXISTS fts_v1_node_update AFTER UPDATE OF label_original,type ON memory_nodes BEGIN INSERT OR IGNORE INTO memory_episode_fts_pending SELECT episode_id FROM memory_evidence WHERE node_id=NEW.id; END;").map_err(db_error)?;
    // Capture an ordered migration range without copying all existing rows.
    db.execute_batch("INSERT OR IGNORE INTO memory_state SELECT 'episode_fts_script_cursor','' WHERE NOT EXISTS(SELECT 1 FROM memory_state WHERE key='episode_fts_script_seeded'); INSERT OR IGNORE INTO memory_state SELECT 'episode_fts_script_end',(SELECT COALESCE(MAX(episode_id),'') FROM memory_episode_fts_meta) WHERE NOT EXISTS(SELECT 1 FROM memory_state WHERE key='episode_fts_script_seeded'); INSERT OR IGNORE INTO memory_state VALUES('episode_fts_script_seeded','1');").map_err(db_error)?;
    db.execute_batch("INSERT OR IGNORE INTO memory_episode_fts_pending SELECT memory_chunk_id FROM memory_chunks WHERE NOT EXISTS(SELECT 1 FROM memory_state WHERE key='episode_fts_v1_seeded'); INSERT OR IGNORE INTO memory_state VALUES('episode_fts_v1_seeded','1');").map_err(db_error)
}

const SCHEMA: &str = "
CREATE VIRTUAL TABLE IF NOT EXISTS memory_episode_fts_v1 USING fts5(summary,entities,claims,source,tokenize='unicode61');
CREATE TABLE IF NOT EXISTS memory_episode_fts_meta(id INTEGER PRIMARY KEY,episode_id TEXT NOT NULL UNIQUE,revision TEXT NOT NULL,project_id TEXT,session_id TEXT,observed_at TEXT,source_refs_json TEXT NOT NULL,content_hash TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_episode_fts_alias_source ON memory_aliases(source_id,surface_original);
CREATE INDEX IF NOT EXISTS idx_episode_fts_project ON memory_episode_fts_meta(project_id,episode_id);
CREATE TABLE IF NOT EXISTS memory_episode_fts_pending(episode_id TEXT PRIMARY KEY) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS fts_v1_chunk_delete BEFORE DELETE ON memory_chunks BEGIN
 DELETE FROM memory_episode_fts_v1 WHERE rowid=(SELECT id FROM memory_episode_fts_meta WHERE episode_id=OLD.memory_chunk_id);
 DELETE FROM memory_episode_fts_meta WHERE episode_id=OLD.memory_chunk_id;
 DELETE FROM memory_episode_fts_pending WHERE episode_id=OLD.memory_chunk_id;
END;
";
