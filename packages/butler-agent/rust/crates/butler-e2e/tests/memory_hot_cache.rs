//! MEM-HOT-ACTIVE: live refresh without embeddings and migrated-cache retention.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use butler_e2e::e2e::fake_servers::{ChatBehavior, FakeServer, LOCAL_MODEL};
use butler_e2e::e2e::scenario::{Fixture, Setup};
use butler_e2e::e2e::{HarnessError, fixtures};
use butler_platform::sqlite;
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use std::path::Path;

const FACT: &str = "My preferred garden flower is the blue iris.";
const NOW: &str = "2026-10-02T04:01:00.000Z";

fn readonly(path: &Path) -> Connection {
    sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap()
}

// Await durable state, never an elapsed delay. The timeout is a harness failure
// guard, not a product latency assertion.
async fn until(mut ready: impl FnMut() -> bool) {
    tokio::time::timeout(std::time::Duration::from_secs(90), async {
        while !ready() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("memory job did not reach its durable completion barrier");
}

fn cache_complete(graph: &Path, turn: &str) -> bool {
    readonly(graph).query_row("SELECT COUNT(*) FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id WHERE c.source_key=?1 AND json_extract(j.semantic_graph_state,'$.state')='complete' AND json_extract(j.hot_cache_state,'$.state')='complete'", [format!("conversation_turn:{turn}")], |row| row.get::<_, i64>(0)).unwrap() == 1
}

fn hot_documents(data: &Path) -> Vec<String> {
    let db = readonly(&data.join("agent-runtime/btcc.sqlite"));
    db.prepare("SELECT content FROM btcc_context_documents WHERE source_id='hot-cache' AND projection_class='optional_hot_cache' ORDER BY context_ref")
        .unwrap().query_map([], |row| row.get(0)).unwrap()
        .map(Result::unwrap).collect()
}

#[tokio::test]
async fn mem_hot_active_refresh_reaches_another_chat() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let server = FakeServer::local_models(ChatBehavior {
        answer: json!({"status":"processed","entities":[],"items":[
            {"kind":"preference","subject":null,"text":FACT,"evidence":[0]}
        ],"attributes":[]})
        .to_string(),
        chunk_delay: std::time::Duration::ZERO,
        ..ChatBehavior::default()
    })
    .await?;
    let setup = Setup::new("MEM-HOT-ACTIVE")?
        .fixture(Fixture::Empty)
        .env("BUTLER_E2E_APP_NOW", NOW)
        .env(
            "BUTLER_E2E_EMBED_MANIFEST",
            format!("{}/unavailable", server.base_url),
        );
    fixtures::onboarding_complete(&setup.sandbox.data)?;
    fixtures::scheduler_ran_today(&setup.sandbox.data, NOW)?;
    let mut s = setup.start().await?;
    let descriptor = s
        .sandbox
        .data
        .join("cognition/memory/active-generation.json");
    until(|| descriptor.exists()).await;
    let active: Value = serde_json::from_slice(&std::fs::read(&descriptor)?)?;
    let generation = s
        .sandbox
        .data
        .join("cognition/memory/generations")
        .join(active["generation_id"].as_str().unwrap());
    let graph = generation.join("graph.sqlite");
    let cache = generation.join("hot/cache.md");
    let before = match std::fs::read(&cache) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error.into()),
    };
    let reply =
        s.gw.post(
            "/model-catalog/local-models",
            json!({
                "provider_id":"local","api_type":"openai_compatible","platform":"ollama",
                "server_url":server.base_url,"model_id":LOCAL_MODEL,"display_name":LOCAL_MODEL,
                "context_window_tokens":131_072,"source":"discovered"
            }),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    let model = reply.data()["model"]["model_ref"]
        .as_str()
        .unwrap()
        .to_owned();
    let reply =
        s.gw.patch(
            "/settings",
            json!({
                "model":model,"consolidation_model":model,"access_mode":"full_access"
            }),
        )
        .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let (turn_id, turn) = s.turn("general", FACT).await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    until(|| readonly(&graph).query_row(
        "SELECT COUNT(*) FROM memory_chunks WHERE source_key=?1 AND summary_status='complete' AND summary LIKE '%blue iris%'",
        [format!("conversation_turn:{turn_id}")], |row| row.get::<_, i64>(0)).unwrap() == 1).await;
    until(|| cache_complete(&graph, &turn_id)).await;
    let refreshed = std::fs::read(&cache)?;
    let refreshed_modified = std::fs::metadata(&cache)?.modified()?;
    assert_ne!(before, refreshed, "cache must refresh before restart");
    assert!(String::from_utf8_lossy(&refreshed).contains("blue iris"));
    let first_documents = hot_documents(&s.sandbox.data);

    // Restart drives the first maintenance tick immediately after readiness.
    // Clear only our fixture's daily markers, with a fixed clock after 04:00.
    s.agent.terminate().await?;
    // Migration retains physical entries without outcome rows. Re-run the real
    // stage with no new window summary; it must keep the valid installed fact.
    let db = sqlite::open(&graph).unwrap();
    db.execute("DELETE FROM memory_hot_cache_outcomes", [])
        .unwrap();
    db.execute("UPDATE memory_projection_windows SET output_json=json_remove(output_json,'$.summary') WHERE job_id IN (SELECT j.job_id FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id WHERE c.source_key=?1)", [format!("conversation_turn:{turn_id}")]).unwrap();
    db.execute("UPDATE memory_projection_jobs SET hot_cache_state='{\"state\":\"pending\"}' WHERE episode_id IN (SELECT memory_chunk_id FROM memory_chunks WHERE source_key=?1)", [format!("conversation_turn:{turn_id}")]).unwrap();
    db.close().unwrap();
    for job in ["session-sync", "consolidation-cycle"] {
        std::fs::remove_file(s.sandbox.data.join(format!("state/scheduler/{job}.json")))?;
    }
    // Seed dormant Box data after initialization, including an expired item and
    // an invalid index. Daily maintenance must neither validate nor rewrite it.
    let box_root = s.sandbox.data.join("cognition/box");
    std::fs::create_dir_all(box_root.join("items/box_expired"))?;
    std::fs::write(
        box_root.join("items/box_expired/manifest.json"),
        br#"{"box_item_id":"box_expired","retention":{"expires_at":"2020-01-01T00:00:00Z"}}"#,
    )?;
    std::fs::write(box_root.join("index.sqlite"), b"dormant index\0\xff")?;
    let box_before = box_snapshot(&box_root)?;
    let calls_before_refresh = server.chat_requests().len();
    s.gw = s.agent.start_again().await?;
    until(|| {
        ["session-sync", "consolidation-cycle"].iter().all(|job| {
            s.sandbox
                .data
                .join(format!("state/scheduler/{job}.json"))
                .exists()
        })
    })
    .await;
    until(|| cache_complete(&graph, &turn_id)).await;
    assert_eq!(
        server.chat_requests().len(),
        calls_before_refresh,
        "cache-only refresh made a model call"
    );
    assert_eq!(
        String::from_utf8_lossy(&refreshed),
        std::fs::read_to_string(&cache)?,
        "valid migrated cache entry was lost during an empty refresh"
    );
    assert_eq!(
        refreshed_modified,
        std::fs::metadata(&cache)?.modified()?,
        "unchanged refresh replaced cache"
    );
    let sync: Value = serde_json::from_slice(&std::fs::read(
        s.sandbox.data.join("state/scheduler/session-sync.json"),
    )?)?;
    assert_eq!(sync["status"], "ok", "{sync}");
    let cycle: Value = serde_json::from_slice(&std::fs::read(
        s.sandbox
            .data
            .join("state/scheduler/consolidation-cycle.json"),
    )?)?;
    assert_eq!(cycle["status"], "ok", "{cycle}");
    assert_eq!(
        box_snapshot(&box_root)?,
        box_before,
        "daily cycle changed dormant Box paths, bytes or modification times"
    );
    let reply =
        s.gw.post(
            "/sessions",
            json!({"kind":"chat","title":"Another garden chat"}),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    let chat = reply.data()["session"]["id"].as_str().unwrap();
    let (later_turn_id, turn) = s.turn(chat, "What flower do I prefer?").await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    until(|| cache_complete(&graph, &later_turn_id)).await;
    until(|| readonly(&graph).query_row("SELECT COUNT(*) FROM memory_projection_jobs WHERE json_extract(hot_cache_state,'$.state')='pending'", [], |row| row.get::<_, i64>(0)).unwrap() == 0).await;
    let after = std::fs::read(&cache)?;
    let later_documents = hot_documents(&s.sandbox.data);
    let db = readonly(&graph);
    let pending: i64 = db.query_row("SELECT COUNT(*) FROM memory_projection_jobs WHERE json_extract(hot_cache_state,'$.state')='pending'", [], |row| row.get(0)).unwrap();
    eprintln!(
        "MEM-HOT-ACTIVE cache_changed={} cache_bytes={} hot_documents_before={} hot_documents_after={} pending_cache_jobs={pending} daily_sync={} daily_cycle={}",
        before != after,
        after.len(),
        first_documents.len(),
        later_documents.len(),
        sync["status"],
        cycle["status"]
    );
    drop(db);
    s.finish().await?;
    assert_eq!(pending, 0, "all pending cache jobs must drain");
    assert!(
        before != after
            && later_documents
                .iter()
                .any(|text| text.contains("blue iris")),
        "completed new memory never reached the active cache or another chat's hot-cache document"
    );
    Ok(())
}

// Include every relative path (also empty directories), bytes and timestamps so
// additions, deletions and same-content replacements all fail the comparison.
type BoxSnapshot = Vec<(std::path::PathBuf, Vec<u8>, std::time::SystemTime)>;

fn box_snapshot(root: &Path) -> std::io::Result<BoxSnapshot> {
    fn visit(root: &Path, path: &Path, entries: &mut BoxSnapshot) -> std::io::Result<()> {
        let metadata = std::fs::metadata(path)?;
        let bytes = if metadata.is_file() {
            std::fs::read(path)?
        } else {
            Vec::new()
        };
        entries.push((
            path.strip_prefix(root).unwrap().to_owned(),
            bytes,
            metadata.modified()?,
        ));
        if metadata.is_dir() {
            for entry in std::fs::read_dir(path)? {
                visit(root, &entry?.path(), entries)?;
            }
        }
        Ok(())
    }
    let mut entries = Vec::new();
    visit(root, root, &mut entries)?;
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(entries)
}
