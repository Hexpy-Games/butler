//! Format pin of the memory health summary and metric dimensions.
//!
//! The golden in `fixtures/format/health.json` was generated from the
//! pre-typing `serde_json::Value` report. Clock-dependent values (times,
//! ages, lags) and the temporary root are normalized. Run with
//! `BUTLER_BLESS_FORMAT=1` to regenerate it only when a format change is
//! intended.

use std::{fs, path::Path, sync::Arc};

use rusqlite::Connection;
use serde_json::{Value, json};

use super::tests::{TestHost, epoch_now, temp_root};
use crate::cognition::{CognitionPathEnvironment, MemoryHealthService};
use crate::coordination::CognitionWriteCoordinator;

fn legacy_stores(root: &Path, now: i64) {
    let memory = root.join("cognition/memory");
    for directory in ["db", "queue", "hot/topics", "rules", "projects", "tasks"] {
        fs::create_dir_all(memory.join(directory)).unwrap();
    }
    fs::create_dir_all(root.join("cognition/consolidation")).unwrap();
    fs::create_dir_all(root.join("transcripts")).unwrap();
    fs::write(
        memory.join("queue/sync.jsonl"),
        "{\"job_id\":\"q\"}\n\n{\"job_id\":\"r\"}\n",
    )
    .unwrap();
    fs::write(memory.join("queue/dead-letter.jsonl"), "{}\n").unwrap();
    fs::write(memory.join("hot/current.md"), "x").unwrap();
    fs::write(memory.join("hot/topics/a.md"), "x").unwrap();
    fs::write(memory.join("rules/INDEX.md"), "x").unwrap();
    fs::write(memory.join("rules/r.md"), "x").unwrap();
    fs::write(memory.join("projects/alpha.md"), "x").unwrap();
    fs::write(
        memory.join("projects/.refresh-failures.jsonl"),
        "{\"ts\":\"2024-01-01T00:00:00.000Z\",\"projectId\":\"a\",\"phase\":\"refresh\",\"message\":\"m\"}\n{\"ts\":1}\n",
    )
    .unwrap();
    fs::write(root.join("transcripts/t.jsonl"), "{}").unwrap();
    fs::write(
        root.join("butler.config.json"),
        r#"{"projects":{"alpha":{"name":"alpha"},"beta":{"name":"beta"},"bad":7}}"#,
    )
    .unwrap();
    fs::write(
        memory.join("db/vector-stats.json"),
        json!({"row_count": 3, "updated_at": butler_core::js_date::format_iso_millis(now).unwrap()})
            .to_string(),
    )
    .unwrap();
    let summary = json!({"phase":"summary","ts":butler_core::js_date::format_iso_millis(now).unwrap(),
        "status":"error","metrics":{"failed_phases":["box_index"]}});
    fs::write(
        root.join("cognition/consolidation/run-summary.jsonl"),
        format!("{summary}\n"),
    )
    .unwrap();
}

fn serving_generation(root: &Path, now: i64) {
    let generation = "11111111-1111-1111-1111-111111111111";
    let memory = root.join("cognition/memory");
    let generation_root = memory.join("generations").join(generation);
    fs::create_dir_all(&generation_root).unwrap();
    fs::write(
        memory.join("active-generation.json"),
        json!({"schema":"butler.memory-active-generation.v2","generation_id":generation,"projection_mode":"running"}).to_string(),
    )
    .unwrap();
    fs::write(
        generation_root.join("manifest.json"),
        json!({"schema":"butler.memory-generation.v2","generation_id":generation,"format":"v2","state":"active","embedding":null}).to_string(),
    )
    .unwrap();
    let graph_path = generation_root.join("graph.sqlite");
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
    db.execute(
        "UPDATE memory_state SET value='3' WHERE key='graph_revision'",
        [],
    )
    .unwrap();
}

#[tokio::test]
async fn health_summary_and_dimensions_keep_their_shape() {
    let root = temp_root();
    let now = epoch_now();
    legacy_stores(&root, now);
    let service = MemoryHealthService::new(
        root.clone(),
        CognitionPathEnvironment::default(),
        Arc::new(CognitionWriteCoordinator::new(Arc::new(TestHost)).unwrap()),
    );
    let without_serving = service.read_at(now).await.unwrap();
    serving_generation(&root, now);
    let with_serving = service.read_at(now).await.unwrap();
    let pinned = json!({
        "without_serving": {
            "dimensions": without_serving.metric_dimensions(),
            "summary": without_serving.summary(),
        },
        "with_serving": {
            "dimensions": with_serving.metric_dimensions(),
            "summary": with_serving.summary(),
        },
    });
    let text = butler_core::json::pretty(&pinned).replace(&root.display().to_string(), "<root>");
    let _ = fs::remove_dir_all(&root);
    let text = regex::Regex::new(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z")
        .unwrap()
        .replace_all(&text, "<time>")
        .into_owned();
    let text =
        regex::Regex::new(r#"("(oldest_pending_age_ms|ingestion_lag_ms|ingestionLagMs)": )\d+"#)
            .unwrap()
            .replace_all(&text, "${1}0")
            .into_owned();
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/cognition/memory_health/fixtures/format/health.json");
    if std::env::var_os("BUTLER_BLESS_FORMAT").is_some() {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, &text).unwrap();
        return;
    }
    let expected = fs::read_to_string(&path).unwrap();
    assert_eq!(text, expected, "memory health format changed");
    let _: Value = serde_json::from_str(&expected).unwrap();
}
