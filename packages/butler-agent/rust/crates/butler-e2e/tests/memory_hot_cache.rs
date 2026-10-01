//! MEM-HOT-ACTIVE: regression reproduction; pending an approved refresh design.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

#[path = "support/memory_fixture.rs"]
mod memory_fixture;

use butler_e2e::e2e::fake_servers::{ChatBehavior, FakeServer, LOCAL_MODEL};
use butler_e2e::e2e::scenario::{Fixture, Setup};
use butler_e2e::e2e::{HarnessError, fixtures};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use std::path::Path;

const FACT: &str = "My preferred garden flower is the blue iris.";
const NOW: &str = "2026-10-02T04:01:00.000Z";

fn readonly(path: &Path) -> Connection {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap()
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
    let graph = memory_fixture::initialize_empty(&setup.sandbox.data)?;
    let cache = graph.parent().unwrap().join("hot/cache.md");
    std::fs::create_dir_all(cache.parent().unwrap())?;
    std::fs::write(&cache, "# Hot cache\n")?;
    let before = std::fs::read(&cache)?;
    let mut s = setup.start().await?;
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
    let first_documents = hot_documents(&s.sandbox.data);

    // Restart drives the first maintenance tick immediately after readiness.
    // Clear only our fixture's daily markers, with a fixed clock after 04:00.
    s.agent.terminate().await?;
    for job in ["session-sync", "consolidation-cycle"] {
        std::fs::remove_file(s.sandbox.data.join(format!("state/scheduler/{job}.json")))?;
    }
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
    let reply =
        s.gw.post(
            "/sessions",
            json!({"kind":"chat","title":"Another garden chat"}),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    let chat = reply.data()["session"]["id"].as_str().unwrap();
    let (_, turn) = s.turn(chat, "What flower do I prefer?").await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
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
    // Keep the expected behavior assertion red until the owner approves a design.
    assert!(
        before != after
            && later_documents
                .iter()
                .any(|text| text.contains("blue iris")),
        "completed new memory never reached the active cache or another chat's hot-cache document"
    );
    Ok(())
}
