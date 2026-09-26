use std::path::PathBuf;

use rusqlite::{Connection, params};
use serde_json::json;

use super::*;
use crate::cognition::recall::RecallRequest;

fn fixture() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(
        "CREATE TABLE memory_projection_jobs(job_id TEXT,generation TEXT,episode_id TEXT,revision TEXT);
         CREATE TABLE memory_chunks(memory_chunk_id TEXT,current_revision TEXT,status TEXT,project_id TEXT,conversation_session_id TEXT);
         CREATE TABLE memory_chunk_sources(source_id TEXT,episode_id TEXT,revision TEXT,source_kind TEXT,
           origin_kind TEXT,role TEXT,basis TEXT,observed_at TEXT,conversation_session_id TEXT,
           conversation_message_id TEXT,part_id TEXT,scalar_pointer TEXT,byte_start INTEGER);
         CREATE TABLE memory_evidence(node_id TEXT,source_id TEXT,episode_id TEXT,revision TEXT);
         CREATE TABLE memory_vector_units(unit_id TEXT,job_id TEXT,record_kind TEXT,owner_id TEXT,
           owner_revision TEXT,project_id TEXT,origin_kind TEXT,state TEXT,receipt_json TEXT,source_ids_json TEXT);
         INSERT INTO memory_projection_jobs VALUES('job','generation','episode','revision');
         INSERT INTO memory_chunks VALUES('episode','revision','active','project','session');
         INSERT INTO memory_chunk_sources VALUES('source','episode','revision','conversation',
           'user_input','user','user_statement','2026-01-01T00:00:00Z','session',
           'message','part','/text',0);
         INSERT INTO memory_evidence VALUES('node','source','episode','revision');",
    ).unwrap();
    db
}

fn generation() -> MemoryGenerationHandle {
    MemoryGenerationHandle {
        generation_id: "generation".into(),
        graph_path: PathBuf::new(),
        root: PathBuf::new(),
        source_root: PathBuf::new(),
        canonical_snapshot_path: None,
        embedding: Some(
            serde_json::from_value(json!({
                "model":"fixture","dimension":3,"pooling":"mean","normalize":true,
                "version":"v1","max_tokens":128,"transformers_version":"fixture",
                "node_runtime_version":"fixture","bun_runtime_version":null,
                "tokenizer_asset_sha256":"fixture","model_asset_sha256":"fixture"
            }))
            .unwrap(),
        ),
    }
}

fn input() -> RecallRequest {
    serde_json::from_value(json!({
        "cue":"node","seedPhrases":[],"vectorQueries":[],"includeVector":true,
        "includeInternal":false,"limit":2,"scope":"current_session","projectFilter":"any",
        "projectIds":[],"sessionIds":[],"asOf":"2026-02-01T00:00:00.000Z",
        "runtime":{"sessionId":"session","turnId":"turn","currentUserMessage":"find node",
          "nativeOperationId":"operation","projectId":"project"}
    }))
    .unwrap()
}

fn hit() -> RecallVectorMatch {
    RecallVectorMatch {
        vector_key: digest(&[
            "memory-vector",
            "generation",
            "node",
            "node",
            "owner-revision",
            "chunk",
            "v1",
        ]),
        generation: "generation".into(),
        embedding_chunk_id: "chunk".into(),
        embedding_version: "v1".into(),
        owner_id: "node".into(),
        owner_revision: "owner-revision".into(),
        source_revision: "stale".into(),
        source_refs_json: "[]".into(),
        project_id: "".into(),
        origin_kind: "".into(),
        source_kind: None,
        conversation_session_id: None,
        source_observed_at: "".into(),
        source_episode_id: None,
        rank: 9,
        distance: 0.25,
    }
}

#[test]
fn node_vector_second_filter_requires_complete_current_unit_and_scoped_source() {
    let db = fixture();
    let generation = generation();
    let hit = hit();
    db.execute(
        "INSERT INTO memory_vector_units VALUES('unit','job','node','node',?1,
      'project','user_input','complete',?2,'[\"source\"]')",
        params![
            hit.owner_revision,
            json!({"vector_keys":[hit.vector_key]}).to_string()
        ],
    )
    .unwrap();
    let selected = current(
        &db,
        &input(),
        &generation,
        &RecallVectorMatches {
            nodes: vec![hit.clone()],
            episodes: vec![],
            diagnostics: vec![],
        },
        &|text| crate::js_date::parse_iso_millis(text).map_or(f64::NAN, |value| value as f64),
    )
    .unwrap();
    assert!(!selected.partial);
    assert_eq!(selected.nodes.len(), 1);
    assert_eq!(
        selected.nodes[0].source_episode_id.as_deref(),
        Some("episode")
    );
    assert_eq!(selected.nodes[0].source_revision, "revision");
    assert_eq!(selected.nodes[0].rank, 1);

    db.execute("UPDATE memory_chunks SET current_revision='new'", [])
        .unwrap();
    let stale = current(
        &db,
        &input(),
        &generation,
        &RecallVectorMatches {
            nodes: vec![hit.clone()],
            episodes: vec![],
            diagnostics: vec![],
        },
        &|text| crate::js_date::parse_iso_millis(text).map_or(f64::NAN, |value| value as f64),
    )
    .unwrap();
    assert!(stale.nodes.is_empty());
    assert!(stale.partial);
    db.execute("UPDATE memory_chunks SET current_revision='revision'", [])
        .unwrap();

    let mut other_session = input();
    other_session.runtime.session_id = "other".into();
    let excluded = current(
        &db,
        &other_session,
        &generation,
        &RecallVectorMatches {
            nodes: vec![hit.clone()],
            episodes: vec![],
            diagnostics: vec![],
        },
        &|text| crate::js_date::parse_iso_millis(text).map_or(f64::NAN, |value| value as f64),
    )
    .unwrap();
    assert!(excluded.nodes.is_empty());
    assert!(excluded.partial);

    let mut wrong_key = hit;
    wrong_key.vector_key = "stale-key".into();
    let rejected = current(
        &db,
        &input(),
        &generation,
        &RecallVectorMatches {
            nodes: vec![wrong_key],
            episodes: vec![],
            diagnostics: vec![],
        },
        &|text| crate::js_date::parse_iso_millis(text).map_or(f64::NAN, |value| value as f64),
    )
    .unwrap();
    assert!(rejected.nodes.is_empty());
    assert!(rejected.partial);
}

#[test]
fn episode_vector_receipt_and_finite_distance_are_required() {
    let db = fixture();
    let generation = generation();
    let mut hit = hit();
    hit.owner_id = "episode".into();
    hit.owner_revision = "episode-chunk".into();
    hit.source_revision = "revision".into();
    hit.vector_key = digest(&[
        "memory-vector",
        "generation",
        "episode",
        "episode",
        "episode-chunk",
        "chunk",
        "v1",
    ]);
    hit.project_id = "project".into();
    hit.origin_kind = "user_input".into();
    hit.conversation_session_id = Some("session".into());
    hit.source_observed_at = "2026-01-01T00:00:00.000Z".into();
    hit.source_refs_json = "[\"source\"]".into();
    db.execute(
        "INSERT INTO memory_vector_units VALUES('unit','job','episode','episode',?1,
      'project','user_input','complete',?2,'[\"source\"]')",
        params![
            hit.owner_revision,
            json!({"vector_keys":[hit.vector_key]}).to_string()
        ],
    )
    .unwrap();
    let parse =
        |text: &str| crate::js_date::parse_iso_millis(text).map_or(f64::NAN, |value| value as f64);
    let selected = current(
        &db,
        &input(),
        &generation,
        &RecallVectorMatches {
            nodes: vec![],
            episodes: vec![hit.clone()],
            diagnostics: vec![],
        },
        &parse,
    )
    .unwrap();
    assert_eq!(selected.episodes.len(), 1);
    assert!(!selected.partial);

    let mut invalid = hit.clone();
    invalid.distance = f64::NAN;
    let rejected = current(
        &db,
        &input(),
        &generation,
        &RecallVectorMatches {
            nodes: vec![],
            episodes: vec![invalid],
            diagnostics: vec![],
        },
        &parse,
    )
    .unwrap();
    assert!(rejected.episodes.is_empty());
    assert!(rejected.partial);

    db.execute("UPDATE memory_vector_units SET state='pending'", [])
        .unwrap();
    let stale = current(
        &db,
        &input(),
        &generation,
        &RecallVectorMatches {
            nodes: vec![],
            episodes: vec![hit],
            diagnostics: vec![],
        },
        &parse,
    )
    .unwrap();
    assert!(stale.episodes.is_empty());
    assert!(stale.partial);
}
