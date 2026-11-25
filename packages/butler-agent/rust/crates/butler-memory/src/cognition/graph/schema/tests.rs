use rusqlite::Connection;
use serde::Deserialize;

use super::*;

#[derive(Deserialize)]
struct Golden {
    objects: Vec<String>,
    columns: std::collections::BTreeMap<String, Vec<String>>,
}

/// Format pin: the memory graph database schema. A fresh database matches the
/// source `ensureSchema` surface and is idempotent, a legacy graph requires
/// its explicit migration, and historical canonical source ids become
/// nullable without rewriting data. A legacy alias postings graph compacts in place once.
// test-category: format-pin
#[test]
fn memory_graph_schema_is_pinned() {
    schema_matches_actual_bun_ensure_schema_surface_and_is_idempotent();
    legacy_graph_requires_the_existing_explicit_migration();
    historical_canonical_source_ids_become_nullable_without_data_rewrite();
    super::super::index_retirement::assert_interrupted_retirement();
    legacy_alias_postings_compact_in_place();
}

fn schema_matches_actual_bun_ensure_schema_surface_and_is_idempotent() {
    let golden: Golden =
        serde_json::from_str(include_str!("tests/fixtures/bun-ensure-schema.json")).unwrap();
    let mut connection = Connection::open_in_memory().unwrap();
    ensure(&mut connection, "2026-09-14T00:00:00.000Z").unwrap();
    ensure(&mut connection, "2026-09-14T00:00:01.000Z").unwrap();
    let objects = connection
        .prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(objects, golden.objects);
    for (table, expected) in golden.columns {
        let columns = connection
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap()
            .query_map([], |row| row.get::<_, String>("name"))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(columns, expected, "column mismatch for {table}");
    }
}

fn legacy_graph_requires_the_existing_explicit_migration() {
    let mut connection = Connection::open_in_memory().unwrap();
    connection
        .execute_batch("CREATE TABLE entities(id TEXT)")
        .unwrap();
    let error = ensure(&mut connection, "2026-09-14T00:00:00.000Z").unwrap_err();
    assert_eq!(error.code(), "memory_schema_migration_required");
}

fn historical_canonical_source_ids_become_nullable_without_data_rewrite() {
    let mut connection = Connection::open_in_memory().unwrap();
    ensure(&mut connection, "2026-09-14T00:00:00.000Z").unwrap();
    connection.execute_batch(
        "PRAGMA foreign_keys=OFF;
         DROP VIEW memory_source_leaves;
         DROP TABLE memory_source_terms;
         DROP TABLE memory_source_text;
         ALTER TABLE memory_chunk_sources RENAME TO source_nullable;
         CREATE TABLE memory_chunk_sources(source_id TEXT PRIMARY KEY,episode_id TEXT NOT NULL REFERENCES memory_chunks(memory_chunk_id),revision TEXT NOT NULL,source_kind TEXT NOT NULL,conversation_session_id TEXT NOT NULL,conversation_message_id TEXT NOT NULL,part_id TEXT NOT NULL,scalar_pointer TEXT NOT NULL,byte_start INTEGER NOT NULL,byte_end INTEGER NOT NULL,content_hash TEXT NOT NULL,role TEXT NOT NULL,origin_kind TEXT NOT NULL,observed_at TEXT NOT NULL,basis TEXT NOT NULL,UNIQUE(episode_id,revision,conversation_message_id,part_id,scalar_pointer,byte_start,byte_end));
         DROP TABLE source_nullable;
         ALTER TABLE memory_source_split_parents RENAME TO parent_nullable;
         CREATE TABLE memory_source_split_parents(source_id TEXT PRIMARY KEY,episode_id TEXT NOT NULL,revision TEXT NOT NULL,source_kind TEXT NOT NULL,conversation_session_id TEXT NOT NULL,conversation_message_id TEXT NOT NULL,part_id TEXT NOT NULL,scalar_pointer TEXT NOT NULL,byte_start INTEGER NOT NULL,byte_end INTEGER NOT NULL,content_hash TEXT NOT NULL,role TEXT NOT NULL,origin_kind TEXT NOT NULL,observed_at TEXT NOT NULL,basis TEXT NOT NULL,child_source_ids_json TEXT NOT NULL,recorded_at TEXT NOT NULL);
         DROP TABLE parent_nullable;
         PRAGMA foreign_keys=ON;",
    ).unwrap();
    ensure(&mut connection, "2026-09-14T00:00:01.000Z").unwrap();
    for table in ["memory_chunk_sources", "memory_source_split_parents"] {
        let not_null: i64 = connection
            .query_row(
                &format!("SELECT [notnull] FROM pragma_table_info('{table}') WHERE name='conversation_message_id'"),
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(not_null, 0, "{table}");
    }
}

const LEGACY_ALIASES: &str = "PRAGMA foreign_keys=OFF; DROP TABLE memory_alias_postings; DROP TABLE memory_aliases;
DELETE FROM memory_state WHERE key='alias_postings_compact_v1';
CREATE TABLE memory_aliases(node_id TEXT NOT NULL REFERENCES memory_nodes(id),surface_original TEXT NOT NULL,nfc_key TEXT NOT NULL,folded_key TEXT NOT NULL,language_tags TEXT NOT NULL DEFAULT '[]',source_id TEXT NOT NULL REFERENCES memory_chunk_sources(source_id),resolution_kind TEXT NOT NULL,PRIMARY KEY(node_id,surface_original,source_id));
CREATE INDEX idx_alias_nfc ON memory_aliases(nfc_key,node_id);
CREATE INDEX idx_alias_folded ON memory_aliases(folded_key,node_id);
CREATE TABLE memory_alias_postings(gram TEXT NOT NULL,node_id TEXT NOT NULL,source_id TEXT NOT NULL,surface_original TEXT NOT NULL,identity_scope TEXT NOT NULL,project_id TEXT,PRIMARY KEY(gram,node_id,source_id,surface_original));
CREATE TABLE fts_probe(n INTEGER);
CREATE TRIGGER fts_v1_memory_aliases_INSERT AFTER INSERT ON memory_aliases BEGIN INSERT INTO fts_probe VALUES(1); END;
INSERT INTO memory_nodes(id,type,label_original,identity_scope,created_at) VALUES('n','entity','정원','user','now');
INSERT INTO memory_aliases(node_id,surface_original,nfc_key,folded_key,source_id,resolution_kind) VALUES('n','정원 물','정원 물','정원 물','s','literal');";

/// Postings become `(gram, alias_id)`, another owner's trigger survives the
/// table rebuild, alias uniqueness holds, and the recovery pass completes an interrupted reclaim.
fn legacy_alias_postings_compact_in_place() {
    let mut connection = Connection::open_in_memory().unwrap();
    ensure(&mut connection, "2026-09-14T00:00:00.000Z").unwrap();
    connection.execute_batch(LEGACY_ALIASES).unwrap();
    ensure(&mut connection, "2026-09-14T00:00:01.000Z").unwrap();
    let columns = connection
        .prepare("SELECT name FROM pragma_table_info('memory_alias_postings')")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(columns, ["gram", "alias_id"]);
    let count = |sql: &str| {
        connection
            .query_row(sql, [], |row| row.get::<_, i64>(0))
            .unwrap()
    };
    // "정원 물": 정원, 원␠, ␠물, 정원␠, 원␠물.
    assert_eq!(count("SELECT COUNT(*) FROM memory_alias_postings"), 5);
    // The fixture rows omit the referenced source row.
    connection.execute_batch("PRAGMA foreign_keys=OFF;
        INSERT INTO memory_aliases(node_id,surface_original,nfc_key,folded_key,source_id,resolution_kind) VALUES('n','정원','정원','정원','s','literal');
        INSERT OR IGNORE INTO memory_aliases(node_id,surface_original,nfc_key,folded_key,source_id,resolution_kind) VALUES('n','정원','x','x','s','literal');").unwrap();
    assert_eq!(count("SELECT COUNT(*) FROM memory_aliases"), 2);
    assert_eq!(count("SELECT COUNT(*) FROM fts_probe"), 2);
    connection
        .execute(
            "UPDATE memory_state SET value='reclaim_pending' WHERE key='alias_postings_compact_v1'",
            [],
        )
        .unwrap();
    recover_interrupted_failures(&mut connection, "2026-09-14T00:00:02.000Z").unwrap();
    let state: String = connection
        .query_row(
            "SELECT value FROM memory_state WHERE key='alias_postings_compact_v1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(state, "complete");
}
