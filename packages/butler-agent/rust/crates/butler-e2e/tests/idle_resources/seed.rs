//! Completed memory jobs and native conversation rows, with owner-sized metrics.
use butler_e2e::e2e::{HarnessError, harness_error};
use butler_platform::sqlite;
use rusqlite::{Connection, params};
use std::{
    fs,
    io::{BufWriter, Write},
    path::{Path, PathBuf},
};

pub(super) struct Expected {
    graph: PathBuf,
    metric_bytes: u64,
}

pub(super) fn owner_scale(data: &Path) -> Result<Expected, HarnessError> {
    let root = data.join("cognition/memory");
    let descriptor: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join("active-generation.json"))?)?;
    let graph = root
        .join("generations")
        .join(descriptor["generation_id"].as_str().unwrap())
        .join("graph.sqlite");
    seed_graph(&graph).map_err(|error| harness_error(error.to_string()))?;
    seed_native_messages(data).map_err(|error| harness_error(error.to_string()))?;
    let line = serde_json::json!({"schema":"butler.operational-event.v1", "ts":chrono::Utc::now().timestamp_millis(), "category":"maintenance", "name":"synthetic", "status":"ok", "rawTextStored":false, "padding":"x".repeat(240)}).to_string() + "\n";
    fs::create_dir_all(data.join("metrics"))?;
    let mut metrics = BufWriter::new(fs::File::create(
        data.join("metrics/operational-events.jsonl"),
    )?);
    for _ in 0..888_000 {
        metrics.write_all(line.as_bytes())?;
    }
    metrics.flush()?;
    Ok(Expected {
        graph,
        metric_bytes: line.len() as u64 * 888_000,
    })
}

fn seed_graph(path: &Path) -> rusqlite::Result<()> {
    let mut db = sqlite::open(path)?;
    let tx = db.transaction()?;
    {
        let mut job = tx.prepare("INSERT INTO memory_projection_jobs(job_id,episode_id,revision,extraction_version,generation,extraction_model,reasoning_effort,observed_completion_job_ids,source_state,semantic_graph_state,episode_vectors_state,node_vectors_state,hot_cache_state,created_at) VALUES(?1,?1,'1','v3','synthetic','stub','low','[]','complete','complete','complete','complete','complete','2026-01-01T00:00:00Z')")?;
        let mut window = tx.prepare("INSERT INTO memory_projection_windows(window_ref,job_id,ordinal,source_refs_json,state) VALUES(?1,?2,0,'[]','complete')")?;
        for index in 0..30_000 {
            let id = format!("idle-{index:05}");
            job.execute([&id])?;
            window.execute(params![format!("window-{index:05}"), id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

fn seed_native_messages(data: &Path) -> rusqlite::Result<()> {
    let mut db = sqlite::open(data.join("runtime/conversation-store.sqlite"))?;
    let tx = db.transaction()?;
    tx.execute("INSERT INTO conversation_sessions(id,gateway_origin,created_at,updated_at,status,schema_version) VALUES('idle-native','app','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','active',4)", [])?;
    {
        let mut message = tx.prepare("INSERT INTO conversation_messages(id,session_id,seq,role,status,visibility,provenance,created_at,origin_kind,origin_evidence_json) VALUES(?1,'idle-native',?2,'user','complete','user','trusted','2026-01-01T00:00:00Z','user_input',?3)")?;
        let mut part = tx.prepare("INSERT INTO conversation_parts(id,message_id,part_index,kind,content_json,status) VALUES(?1,?1,0,'text',?2,'complete')")?;
        let evidence = serde_json::json!({"padding":"x".repeat(200)}).to_string();
        for index in 0..30_000 {
            let id = format!("native-{index:06}");
            message.execute(params![id, index + 1, evidence])?;
            part.execute(params![
                id,
                serde_json::json!({"text":format!("Fact {index}")}).to_string()
            ])?;
        }
    }
    tx.execute(
        "UPDATE conversation_public_source_state SET revision=revision+1 WHERE singleton=1",
        [],
    )?;
    tx.commit()?;
    Ok(())
}

pub(super) fn assert_complete(data: &Path, expected: &Expected) -> Result<(), HarnessError> {
    let app = sqlite::open(data.join("app-server/butler-client.sqlite")).unwrap();
    assert_eq!(
        count(&app, "SELECT COUNT(*) FROM turns WHERE id LIKE 'perf-t%'"),
        5_000
    );
    assert_eq!(
        count(
            &app,
            "SELECT COUNT(*) FROM events WHERE type='agent.turn_event' AND turn_id LIKE 'perf-t%'"
        ),
        200_000
    );
    assert_eq!(
        count(
            &app,
            "SELECT COUNT(*) FROM app_terminal_turn_projections WHERE turn_id LIKE 'perf-t%'"
        ),
        5_000
    );
    let canonical = sqlite::open(data.join("runtime/conversation-store.sqlite")).unwrap();
    assert_eq!(
        count(
            &canonical,
            "SELECT COUNT(*) FROM conversation_messages WHERE session_id='idle-native'"
        ),
        30_000
    );
    assert_eq!(
        count(
            &canonical,
            "SELECT COUNT(*) FROM conversation_parts WHERE message_id LIKE 'native-%'"
        ),
        30_000
    );
    let last: String = canonical
        .query_row(
            "SELECT content_json FROM conversation_parts WHERE message_id='native-029999'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&last)?["text"],
        "Fact 29999"
    );
    let graph = sqlite::open(&expected.graph).unwrap();
    assert_eq!(
        count(
            &graph,
            "SELECT COUNT(*) FROM memory_projection_windows WHERE state='complete'"
        ),
        30_000
    );
    assert_eq!(
        fs::metadata(data.join("metrics/operational-events.jsonl"))?.len(),
        expected.metric_bytes
    );
    Ok(())
}

fn count(db: &Connection, sql: &str) -> i64 {
    db.query_row(sql, [], |row| row.get(0)).unwrap()
}
