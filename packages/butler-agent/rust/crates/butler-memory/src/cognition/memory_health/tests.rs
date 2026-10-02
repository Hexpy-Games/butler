use std::{
    fs,
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::Connection;
use serde_json::json;

use crate::{
    cognition::{CognitionPathEnvironment, MemoryHealthService},
    coordination::{
        CognitionCoordinationHost, CognitionProcessStatus, CognitionWriteCoordinator,
        CoordinationResult,
    },
};

pub(super) struct TestHost;

impl CognitionCoordinationHost for TestHost {
    fn process_id(&self) -> u32 {
        std::process::id()
    }

    fn hostname(&self) -> CoordinationResult<String> {
        Ok("memory-health-test".into())
    }

    fn process_status(&self, _pid: u64) -> CognitionProcessStatus {
        CognitionProcessStatus::Alive
    }

    fn new_uuid(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }

    fn now_epoch_millis(&self) -> i64 {
        epoch_now()
    }

    fn now_iso(&self) -> String {
        butler_core::js_date::format_iso_millis(epoch_now()).expect("test timestamp")
    }
}

pub(super) fn epoch_now() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(i64::MAX)
}

pub(super) fn temp_root() -> PathBuf {
    std::env::temp_dir().join(format!(
        "butler-memory-health-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ))
}

#[tokio::test]
async fn active_generation_serving_health_reads_populated_graph_without_writing() {
    let root = temp_root();
    let graph_path = seed_active_generation(&root);
    let before = fs::read(&graph_path).unwrap();
    let service = MemoryHealthService::new(
        root.clone(),
        CognitionPathEnvironment::default(),
        Arc::new(CognitionWriteCoordinator::new(Arc::new(TestHost)).unwrap()),
    );
    let report = service.read_tool(no_profile_coverage()).await.unwrap();
    let summary = report.summary().unwrap();
    let serving = &summary["serving"];
    assert_eq!(serving["available"], true, "{serving}");
    assert_eq!(serving["sources"]["registered_current"], 1);
    assert_eq!(serving["sources"]["inventory_complete"], false);
    assert_eq!(serving["sources"]["eligible"], serde_json::Value::Null);
    assert_eq!(
        serving["sources"]["coverage_percent"],
        serde_json::Value::Null
    );
    assert_eq!(
        serving["sources"]["inventory_reason"],
        "canonical_inventory_unavailable"
    );
    assert_eq!(serving["stages"]["semantic_graph"]["failed"], 1);
    assert_eq!(serving["stages"]["episode_vectors"]["failed"], 1);
    assert_eq!(serving["source_resolution_failures"], 1);
    assert_eq!(serving["embedding_version_mismatch"], 1);
    assert_eq!(serving["memories_without_vectors"], 1);
    assert!(serving["oldest_vector_pending_at"].as_str().is_some());
    assert!(
        summary["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value
                .as_str()
                .unwrap()
                .starts_with("1 memories without vectors; oldest "))
    );
    assert_eq!(serving["graph_revision"], 3);
    assert_eq!(fs::read(&graph_path).unwrap(), before);
    fs::remove_dir_all(root).unwrap();
}

/// An active generation whose graph has one current source with a failed
/// window and a failed vector unit; the graph path.
fn seed_active_generation(root: &std::path::Path) -> PathBuf {
    let generation = "11111111-1111-1111-1111-111111111111";
    let memory = root.join("cognition/memory");
    let generation_root = memory.join("generations").join(generation);
    fs::create_dir_all(&generation_root).unwrap();
    fs::write(
        memory.join("active-generation.json"),
        json!({
            "schema":"butler.memory-active-generation.v2",
            "generation_id":generation,"projection_mode":"running"
        })
        .to_string(),
    )
    .unwrap();
    fs::write(
        generation_root.join("manifest.json"),
        json!({
            "schema":"butler.memory-generation.v2","generation_id":generation,
            "format":"v2","state":"active","embedding":null
        })
        .to_string(),
    )
    .unwrap();
    let graph_path = generation_root.join("graph.sqlite");
    let now = epoch_now();
    let at = butler_core::js_date::format_iso_millis(now - 5_000).unwrap();
    drop(Connection::open(&graph_path).unwrap());
    let mut graph = crate::cognition::graph::GraphRepository::open(&graph_path).unwrap();
    graph.ensure_schema(&at).unwrap();
    graph.close().unwrap();
    let db = Connection::open(&graph_path).unwrap();
    db.execute("INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,origin_kind,status,source_hash,created_at,updated_at) VALUES('episode','source','r1','user_input','active','hash',?1,?1)", [&at]).unwrap();
    db.execute("INSERT INTO memory_chunk_sources(source_id,episode_id,revision,source_kind,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis) VALUES('source','episode','r1','conversation','part','/text',0,4,'hash','user','user_input',?1,'fixture')", [&at]).unwrap();
    db.execute("INSERT INTO memory_projection_jobs(job_id,episode_id,revision,extraction_version,generation,extraction_model,reasoning_effort,observed_completion_job_ids,source_state,semantic_graph_state,episode_vectors_state,node_vectors_state,hot_cache_state,created_at) VALUES('job','episode','r1','v1',?1,'fixture','medium','[]','{}','{}','{}','{}','{\"state\":\"pending\"}',?2)", rusqlite::params![generation,at]).unwrap();
    db.execute("INSERT INTO memory_projection_windows(window_ref,job_id,ordinal,source_refs_json,state,error_code) VALUES('window','job',0,'[]','failed','memory_source_missing')",[]).unwrap();
    db.execute("INSERT INTO memory_vector_units(unit_id,job_id,record_kind,owner_id,owner_revision,origin_kind,projection_text,state,error_code) VALUES('unit','job','episode','episode','r1','user_input','fixture','failed','memory_embedding_version_mismatch')",[]).unwrap();
    db.execute(
        "UPDATE memory_state SET value='3' WHERE key='graph_revision'",
        [],
    )
    .unwrap();
    drop(db);
    graph_path
}

/// Profile coverage that is unavailable.
fn no_profile_coverage() -> crate::profile::ProfileCoverageHealth {
    crate::profile::ProfileCoverageHealth {
        available: false,
        reason: Some("fixture"),
        consent_mode: "off",
        processed_windows: 0,
        pending_windows: 0,
        failed_windows: 0,
        stale_history_windows: 0,
        historical_processed_windows: 0,
        discovery_incomplete: None,
        discovery_reason: None,
    }
}
