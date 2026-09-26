use rusqlite::Connection;
use serde_json::{Map, Value};

use super::run;

#[test]
fn v2_recomputes_support_in_qualifier_order_and_rejects_legacy_schema() {
    let mut connection = Connection::open_in_memory().expect("open in-memory graph");
    connection
        .execute_batch(
            "CREATE TABLE edges(edge_id TEXT PRIMARY KEY,qualifiers TEXT NOT NULL);
             CREATE TABLE edge_evidence(edge_id TEXT,chunk_source_id TEXT);
             CREATE TABLE memory_chunk_sources(source_id TEXT,episode_id TEXT,revision TEXT,observed_at TEXT);
             CREATE TABLE memory_chunks(memory_chunk_id TEXT,current_revision TEXT,status TEXT);
             INSERT INTO edges VALUES('e1','{\"custom\":{\"kept\":true},\"active_support_episodes\":99,\"decayed_support\":99,\"tail\":\"kept\"}');
             INSERT INTO memory_chunks VALUES('episode-1','r1','active'),('episode-2','r2','active'),('episode-3','r3','archived');
             INSERT INTO memory_chunk_sources VALUES
               ('s1','episode-1','r1','2026-09-18T00:00:00.000Z'),
               ('s1-old','episode-1','old','2026-09-01T00:00:00.000Z'),
               ('s2','episode-2','r2','2026-09-21T00:00:00.000Z'),
               ('s3','episode-3','r3','2026-09-22T00:00:00.000Z');
             INSERT INTO edge_evidence VALUES('e1','s1'),('e1','s1-old'),('e1','s2'),('e1','s3');",
        )
        .expect("create v2 fixture");

    let now = crate::js_date::parse_date_millis("2026-09-23T00:00:00.000Z", &Some)
        .expect("test timestamp");
    let metrics = run(&mut connection, now, 1.0).expect("consolidate v2 edge");
    assert_eq!(metrics.candidates_considered, 1);
    assert_eq!(metrics.merges_applied, 0);
    assert_eq!(metrics.edges_boosted, 1);
    assert_eq!(metrics.conflicts_archived, 0);
    assert_eq!(metrics.activations_written, 0);

    let raw = connection
        .query_row(
            "SELECT qualifiers FROM edges WHERE edge_id='e1'",
            [],
            |row| row.get::<_, String>(0),
        )
        .expect("read consolidated qualifiers");
    let qualifiers = serde_json::from_str::<Map<String, Value>>(&raw).expect("parse qualifiers");
    assert_eq!(
        qualifiers.keys().map(String::as_str).collect::<Vec<_>>(),
        [
            "custom",
            "active_support_episodes",
            "decayed_support",
            "tail"
        ]
    );
    assert_eq!(qualifiers["custom"]["kept"], true);
    assert_eq!(qualifiers["active_support_episodes"], 2);
    assert!(
        (qualifiers["decayed_support"]
            .as_f64()
            .expect("decayed support")
            - 2.0 / 3.0)
            .abs()
            < 1e-12
    );
    assert_eq!(qualifiers["tail"], "kept");

    let mut legacy = Connection::open_in_memory().expect("open legacy graph");
    legacy
        .execute_batch("CREATE TABLE edges(id TEXT PRIMARY KEY,qualifiers TEXT);")
        .expect("create legacy fixture");
    assert_eq!(
        run(&mut legacy, now, 1.0)
            .expect_err("legacy schema must not report success")
            .code,
        "memory_consolidation_v2_required"
    );
}
