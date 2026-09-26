use rusqlite::Connection;
use serde::Deserialize;

use super::*;

#[derive(Deserialize)]
struct Golden {
    objects: Vec<String>,
    columns: std::collections::BTreeMap<String, Vec<String>>,
}

#[test]
fn native_schema_matches_actual_bun_ensure_schema_surface_and_is_idempotent() {
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

#[test]
fn legacy_graph_requires_the_existing_explicit_migration() {
    let mut connection = Connection::open_in_memory().unwrap();
    connection
        .execute_batch("CREATE TABLE entities(id TEXT)")
        .unwrap();
    let error = ensure(&mut connection, "2026-09-14T00:00:00.000Z").unwrap_err();
    assert_eq!(error.code, "memory_schema_migration_required");
}

#[test]
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
