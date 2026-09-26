use std::{
    fs,
    io::Write,
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

struct TestHost;

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
        crate::js_date::format_iso_millis(epoch_now()).expect("test timestamp")
    }
}

fn epoch_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn temp_root() -> PathBuf {
    std::env::temp_dir().join(format!(
        "butler-memory-health-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ))
}

#[tokio::test]
async fn vector_snapshot_and_maintenance_status_drive_source_diagnostics() {
    let root = temp_root();
    let memory = root.join("cognition/memory");
    let now = epoch_now();
    fs::create_dir_all(memory.join("db")).expect("create memory db dir");
    fs::create_dir_all(memory.join("queue")).expect("create queue dir");
    fs::create_dir_all(root.join("cognition/consolidation")).expect("create maintenance dir");
    fs::write(memory.join("queue/sync.jsonl"), "{\"job_id\":\"queued\"}\n")
        .expect("write queue row");

    let metadata = Connection::open(memory.join("metadata.sqlite")).expect("metadata db");
    metadata
        .execute_batch(
            "CREATE TABLE memory_chunks(memory_chunk_id TEXT); INSERT INTO memory_chunks VALUES('chunk-1');",
        )
        .expect("create metadata fixture");
    drop(metadata);
    let graph = Connection::open(memory.join("db/graph.sqlite")).expect("graph db");
    graph
        .execute_batch(
            "CREATE TABLE memory_nodes(id TEXT); CREATE TABLE edges(id TEXT); CREATE TABLE memory_evidence(id TEXT); INSERT INTO memory_nodes VALUES('node-1');",
        )
        .expect("create graph fixture");
    drop(graph);

    let failed_summary = json!({
        "phase": "summary",
        "ts": crate::js_date::format_iso_millis(now).expect("timestamp"),
        "status": "error",
        "metrics": {"failed_phases": ["box_index", "source_quality"]}
    });
    fs::write(
        root.join("cognition/consolidation/run-summary.jsonl"),
        format!("{failed_summary}\n"),
    )
    .expect("write failed summary");

    let service = MemoryHealthService::new(
        root.clone(),
        CognitionPathEnvironment::default(),
        Arc::new(CognitionWriteCoordinator::new(Arc::new(TestHost)).expect("coordinator")),
    );
    let missing_vector = service
        .read_at(now)
        .await
        .expect("read missing-vector health");
    assert_eq!(missing_vector.memory_chunks_count, 1);
    assert_eq!(missing_vector.vector_rows_count, None);
    assert_eq!(missing_vector.maintenance_status.as_str(), "failed");
    assert_eq!(missing_vector.metric_status, "error");
    assert_eq!(missing_vector.diagnostics_count, 4);
    assert_eq!(missing_vector.metric_dimensions["queue_backlog_count"], 1);
    assert_eq!(
        missing_vector.metric_dimensions["maintenance_failed_phases_count"],
        2
    );
    assert_eq!(missing_vector.metric_dimensions["serving_available"], false);

    fs::create_dir_all(memory.join("hot")).expect("create hot dir");
    fs::write(memory.join("hot/current.md"), "projection\n").expect("write hot cache file");
    fs::write(
        memory.join("db/vector-stats.json"),
        serde_json::to_vec(&json!({
            "row_count": 7,
            "updated_at": crate::js_date::format_iso_millis(now + 1_000).expect("timestamp")
        }))
        .expect("serialize vector stats"),
    )
    .expect("write vector stats");
    let repaired_summary = json!({
        "phase": "summary",
        "ts": crate::js_date::format_iso_millis(now + 1_000).expect("timestamp"),
        "status": "ok",
        "metrics": {"failed_phases": []}
    });
    fs::OpenOptions::new()
        .append(true)
        .open(root.join("cognition/consolidation/run-summary.jsonl"))
        .expect("open maintenance summary")
        .write_all(format!("{repaired_summary}\n").as_bytes())
        .expect("append repaired summary");

    let present_vector = service
        .read_at(now + 1_000)
        .await
        .expect("read present-vector health");
    assert_eq!(present_vector.vector_rows_count, Some(7.0));
    assert_eq!(present_vector.maintenance_status.as_str(), "repaired");
    assert_eq!(present_vector.metric_status, "ok");
    assert_eq!(present_vector.diagnostics_count, 2);
    assert_eq!(present_vector.metric_dimensions["stale"], false);
    assert_eq!(
        present_vector.metric_dimensions["maintenance_failed_phases_count"],
        0
    );
    fs::remove_dir_all(root).expect("remove fixture");
}

#[tokio::test]
async fn active_generation_serving_health_reads_populated_graph_without_writing() {
    let root = temp_root();
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
    let at = crate::js_date::format_iso_millis(now - 5_000).unwrap();
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
    let before = fs::read(&graph_path).unwrap();
    let service = MemoryHealthService::new(
        root.clone(),
        CognitionPathEnvironment::default(),
        Arc::new(CognitionWriteCoordinator::new(Arc::new(TestHost)).unwrap()),
    );
    let report = service
        .read_tool(json!({"available":false,"reason":"fixture"}))
        .await
        .unwrap();
    let serving = &report.summary["serving"];
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
    assert_eq!(serving["graph_revision"], 3);
    assert_eq!(fs::read(&graph_path).unwrap(), before);
    fs::remove_dir_all(root).unwrap();
}
