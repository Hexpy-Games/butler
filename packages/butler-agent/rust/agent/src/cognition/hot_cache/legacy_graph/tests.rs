
use std::{fs, path::PathBuf};

use rusqlite::Connection;
use serde_json::json;

use super::*;

fn temp_root() -> PathBuf {
    std::env::temp_dir().join(format!(
        "butler-legacy-graph-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ))
}

#[test]
fn persists_deterministic_mentions_and_increments_legacy_edges() {
    let root = temp_root();
    let memory = root.join("cognition/memory");
    let text = "SQLite is a durable local store. We decided SQLite.";
    extract_and_save(
        &root,
        &memory,
        text,
        "session-a",
        "alpha",
        Some("hot-cache"),
        1234,
    )
    .unwrap();
    extract_and_save(
        &root,
        &memory,
        text,
        "session-a",
        "alpha",
        Some("hot-cache"),
        1235,
    )
    .unwrap();

    let connection = Connection::open(memory.join("db/graph.sqlite")).unwrap();
    let mentions: i64 = connection
        .query_row("SELECT count(*) FROM entity_mentions", [], |row| row.get(0))
        .unwrap();
    let edge_count: i64 = connection
        .query_row("SELECT count(*) FROM edges", [], |row| row.get(0))
        .unwrap();
    let max_weight: f64 = connection
        .query_row("SELECT max(weight) FROM edges", [], |row| row.get(0))
        .unwrap();
    let source: String = connection
        .query_row("SELECT source FROM entity_mentions LIMIT 1", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(mentions, 8);
    assert_eq!(edge_count, 2);
    assert_eq!(max_weight, 2.0);
    assert_eq!(source, "hot-cache");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn v2_descriptor_refuses_legacy_graph_creation() {
    let root = temp_root();
    let memory = root.join("cognition/memory");
    fs::create_dir_all(&memory).unwrap();
    fs::write(
        memory.join("active-generation.json"),
        serde_json::to_vec(&json!({"schema":"butler.memory-active-generation.v2"})).unwrap(),
    )
    .unwrap();
    assert_eq!(
        extract_and_save(
            &root,
            &memory,
            "alpha",
            "session-a",
            "alpha",
            Some("hot-cache"),
            1234
        )
        .unwrap_err(),
        "legacy_memory_writer_disabled_for_v2"
    );
    assert!(!memory.join("db/graph.sqlite").exists());
    let _ = fs::remove_dir_all(root);
}
