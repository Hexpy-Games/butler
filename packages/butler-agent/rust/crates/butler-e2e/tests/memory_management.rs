//! Settings memory backend and the deliberately failing profile-clear reproduction.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "E2E assertions"
)]
use butler_e2e::e2e::fake_servers::LOCAL_MODEL;
use butler_e2e::e2e::scenario::{Fixture, Scenario, Setup};
use butler_e2e::e2e::{HarnessError, fixtures};
use butler_platform::sqlite;
use rusqlite::OpenFlags;
use serde_json::{Value, json};
use std::{path::Path, time::Duration};
#[path = "support/memory_fixture.rs"]
mod memory_fixture;
const NOW: &str = "2026-10-02T04:01:00.000Z";
const ORPHAN: &str = "00000000-0000-4000-8000-000000000333";
const RETIRED: &str = "00000000-0000-4000-8000-000000000444";
const FACT: &str = "Prefers concise answers";

async fn until(mut ready: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(90), async {
        while !ready() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("durable completion barrier");
}

fn sql_count(path: &Path, sql: &str) -> i64 {
    sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .unwrap()
        .query_row(sql, [], |row| row.get(0))
        .unwrap()
}

async fn setup(id: &str) -> Result<Scenario, HarnessError> {
    let setup = Setup::new(id)?
        .fixture(Fixture::Empty)
        .env("BUTLER_E2E_APP_NOW", NOW)
        .env(
            "BUTLER_E2E_EMBED_MANIFEST",
            "http://127.0.0.1:1/unavailable",
        );
    fixtures::onboarding_complete(&setup.sandbox.data)?;
    fixtures::scheduler_ran_today(&setup.sandbox.data, NOW)?;
    memory_fixture::initialize_empty(&setup.sandbox.data)?;
    setup.start().await
}

async fn completed(s: &Scenario, id: &str) -> Result<Value, HarnessError> {
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            // The durable receipt precedes the asynchronous App event write.
            // Use the completion event as the barrier, then read the receipt once.
            let events = s.gw.events_since(0).await?;
            for event in events.iter().filter(|event| {
                event["type"] == "memory.operation" && event["payload"]["operation_id"] == id
            }) {
                assert!(
                    event["payload"]["phase"] != "failed",
                    "cleanup failed: {event}"
                );
                if event["payload"]["phase"] == "complete" {
                    let reply = s.gw.get(&format!("/memory/cleanup/{id}")).await?;
                    assert_eq!(reply.data()["phase"], "complete");
                    return Ok(reply.data().clone());
                }
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("cleanup completion event")
}

#[tokio::test]
async fn inventory_and_explicit_cleanup_preserve_memory_and_replay_receipts()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = setup("MEM-MANAGE").await?;
    assert_fresh_inventory(&s).await?;
    let CleanupFixture {
        memory,
        generation,
        graph_before,
        orphan_bytes,
    } = seed_dormant(&s)?;
    let measured = s.gw.post("/memory/inventory/check", json!({})).await?;
    assert_eq!(measured.status, 200, "{}", measured.text);
    assert_eq!(measured.data()["kinds"][0]["item_count"], 1);
    assert!(
        measured.data()["kinds"][0]["allocated_bytes"]
            .as_u64()
            .unwrap()
            > 0
    );
    assert!(
        measured.data()["dead_letter_allocated_bytes"]
            .as_u64()
            .unwrap()
            > 0
    );
    let id = uuid::Uuid::new_v4().to_string();
    let input = json!({"operation_id":id,"inventory_revision":measured.data()["revision"]});
    let started = s.gw.post("/memory/cleanup", input.clone()).await?;
    assert_eq!(started.status, 202, "{}", started.text);
    let result = completed(&s, &id).await?;
    assert_eq!(result["bytes_reclaimed"], orphan_bytes.unwrap_or(0));
    assert!(!memory.join(format!("generations/{ORPHAN}")).exists());
    assert!(
        memory
            .join(format!(
                "generations/{RETIRED}/source-snapshot/runtime/conversation-store.sqlite"
            ))
            .exists()
    );
    assert_eq!(
        std::fs::read(generation.join("graph.sqlite"))?,
        graph_before
    );
    assert_eq!(
        std::fs::read_to_string(memory.join("rules/kept.md"))?,
        "Keep concise explanations."
    );
    assert_eq!(
        std::fs::read_to_string(memory.join("queue/dead-letter.jsonl"))?,
        "unresolved"
    );
    let repeat = s.gw.post("/memory/cleanup", input.clone()).await?;
    assert_eq!(repeat.data(), &result);
    let events = s.gw.events_since(0).await?;
    assert!(
        events
            .iter()
            .any(|v| v.to_string().contains("memory.operation")
                && v.to_string().contains("complete"))
    );
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    assert_eq!(
        s.gw.get(&format!("/memory/cleanup/{id}")).await?.data(),
        &result
    );
    assert_eq!(
        s.gw.get("/memory/inventory").await?.data()["state"],
        "not_measured"
    );
    assert_eq!(s.gw.post("/memory/cleanup", input).await?.data(), &result);
    s.finish().await?;
    legacy_management_is_unreachable()
}

async fn local_model(s: &Scenario, base: &str) -> Result<String, HarnessError> {
    let reply =
        s.gw.post(
            "/model-catalog/local-models",
            json!({"provider_id":"local",
        "api_type":"openai_compatible","platform":"ollama","server_url":base,
        "model_id":LOCAL_MODEL,"display_name":LOCAL_MODEL,"context_window_tokens":131_072,
        "source":"discovered"}),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    let model = reply.data()["model"]["model_ref"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        s.gw.patch(
            "/settings",
            json!({"model":model,"consolidation_model":model})
        )
        .await?
        .status,
        200
    );
    Ok(model)
}

async fn cycle(s: &mut Scenario) -> Result<(), HarnessError> {
    s.agent.terminate().await?;
    for job in ["session-sync", "consolidation-cycle"] {
        let path = s.sandbox.data.join(format!("state/scheduler/{job}.json"));
        if path.exists() {
            std::fs::remove_file(path)?;
        }
    }
    s.gw = s.agent.start_again().await?;
    let marker = s
        .sandbox
        .data
        .join("state/scheduler/consolidation-cycle.json");
    until(|| marker.exists()).await;
    let result: Value = serde_json::from_slice(&std::fs::read(marker)?)?;
    assert_eq!(result["status"], "ok", "{result}");
    Ok(())
}

#[tokio::test]
async fn wiring_profile_clear_relearns_from_old_chats() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (base, server) = profile_server().await?;
    let mut s = setup("MEM-PROFILE-CLEAR").await?;
    local_model(&s, &base).await?;
    let mode =
        s.gw.patch("/personalization", json!({"profiling":{"mode":"basic"}}))
            .await?;
    assert_eq!(mode.status, 200, "{}", mode.text);
    let pinned = s.sandbox.data.join("cognition/memory/rules/kept.md");
    std::fs::create_dir_all(pinned.parent().unwrap())?;
    std::fs::write(&pinned, "Keep this pinned memory.")?;
    let (_, turn) = s
        .turn(
            "general",
            "I prefer concise answers. Please remember my communication preference.",
        )
        .await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    cycle(&mut s).await?;
    let db = s.sandbox.data.join("cognition/profile/profile.sqlite");
    assert!(
        sql_count(
            &db,
            "SELECT COUNT(*) FROM stable_profile_entries WHERE payload_json LIKE '%Prefers concise answers%'"
        ) > 0
    );
    let inventory = s.gw.post("/memory/inventory/check", json!({})).await?;
    assert_eq!(inventory.status, 200, "{}", inventory.text);
    assert!(inventory.data()["kinds"][1]["item_count"].as_u64().unwrap() > 0);
    assert_eq!(inventory.data()["kinds"][2]["item_count"], 1);
    assert_eq!(inventory.data()["kinds"][2]["health"]["consent_on"], true);
    let cleared =
        s.gw.patch(
            "/personalization",
            json!({"profiling":{"clear_profile":true}}),
        )
        .await?;
    assert_eq!(cleared.status, 200, "{}", cleared.text);
    assert_eq!(
        sql_count(&db, "SELECT COUNT(*) FROM stable_profile_entries"),
        0
    );
    assert_eq!(
        std::fs::read_to_string(&pinned)?,
        "Keep this pinned memory."
    );
    cycle(&mut s).await?;
    let relearned = sql_count(
        &db,
        "SELECT COUNT(*) FROM stable_profile_entries WHERE payload_json LIKE '%Prefers concise answers%'",
    );
    assert_eq!(
        std::fs::read_to_string(&pinned)?,
        "Keep this pinned memory."
    );
    s.finish().await?;
    server.abort();
    assert_eq!(
        relearned, 0,
        "existing clear loses coverage/scan offset and relearns old chats; phase 2 must establish an admission floor"
    );
    Ok(())
}

async fn profile_server() -> Result<(String, tokio::task::JoinHandle<()>), HarnessError> {
    use axum::{Router, routing::post};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let base = format!("http://{}", listener.local_addr()?);
    let router = Router::new().route("/v1/chat/completions", post(profile_reply));
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    Ok((base, task))
}

async fn profile_reply(axum::Json(request): axum::Json<Value>) -> axum::response::Response {
    use axum::response::IntoResponse;
    let prompt = request["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|message| message["content"].as_str())
        .find_map(|text| serde_json::from_str::<Value>(text).ok());
    let text = match prompt.as_ref() {
        Some(value) if value["task"] == "extract_profile_candidates" => {
            let observations = value["observations"].as_array().unwrap();
            let references: Vec<Value> = observations
                .iter()
                .filter(|v| v["text"].as_str().is_some_and(|t| t.contains("concise")))
                .map(|v| v["ref"].clone())
                .collect();
            if references.is_empty() {
                json!({"candidates":[]}).to_string()
            } else {
                json!({"candidates":[{"category":"communication","summary":FACT,
                "source_type":"explicit","confidence":"high","evidence_refs":references,
                "sensitive_domain":false}]})
                .to_string()
            }
        }
        Some(_) => {
            json!({"status":"processed","entities":[],"items":[],"attributes":[]}).to_string()
        }
        None => "Understood.".into(),
    };
    if request["stream"] == true {
        let first = json!({"id":"stub","object":"chat.completion.chunk","model":LOCAL_MODEL,
            "choices":[{"index":0,"delta":{"role":"assistant","content":text},"finish_reason":null}]});
        let last = json!({"id":"stub","object":"chat.completion.chunk","model":LOCAL_MODEL,
            "choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":10,"total_tokens":30}});
        (
            [("content-type", "text/event-stream")],
            format!("data: {first}\n\ndata: {last}\n\ndata: [DONE]\n\n"),
        )
            .into_response()
    } else {
        axum::Json(json!({"id":"stub","object":"chat.completion","model":LOCAL_MODEL,
            "choices":[{"index":0,"message":{"role":"assistant","content":text},"finish_reason":"stop"}],
            "usage":{"prompt_tokens":20,"completion_tokens":10,"total_tokens":30}})).into_response()
    }
}

#[tokio::test]
async fn interrupted_trash_waits_for_an_explicit_cleanup_after_restart() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let mut s = setup("MEM-MANAGE-RESTART").await?;
    s.agent.terminate().await?;
    let memory = s.sandbox.data.join("cognition/memory");
    let id = uuid::Uuid::new_v4().to_string();
    let source = memory.join(format!("generations/{ORPHAN}"));
    std::fs::create_dir_all(&source)?;
    let bytes = butler_platform::storage_size::allocated_bytes(&source)?.unwrap_or(0);
    let operation = memory.join("management/operations").join(&id);
    std::fs::create_dir_all(operation.join("trash"))?;
    // Exact disk state at the crash boundary: receipt synced, rename committed,
    // worker interrupted before unlink. Startup must leave it alone.
    std::fs::write(
        operation.join("receipt.json"),
        json!({"operation_id":id,
        "inventory_revision":0,"phase":"removing","sequence":2,"bytes_reclaimed":0,
        "items":[{"name":format!("generations/{ORPHAN}"),"allocated_bytes":bytes,
            "outcome":"renamed","reason":"unpublished_empty_generation"}]})
        .to_string(),
    )?;
    std::fs::rename(source, operation.join("trash/0"))?;
    s.gw = s.agent.start_again().await?;
    assert!(
        operation.join("trash/0").exists(),
        "startup performed automatic cleanup"
    );
    let resumed = uuid::Uuid::new_v4().to_string();
    let inventory = s.gw.get("/memory/inventory").await?;
    let started =
        s.gw.post(
            "/memory/cleanup",
            json!({"operation_id":resumed,"inventory_revision":inventory.data()["revision"]}),
        )
        .await?;
    assert_eq!(started.status, 202, "{}", started.text);
    let result = completed(&s, &resumed).await?;
    assert_eq!(result["bytes_reclaimed"], bytes);
    assert!(!operation.join("trash/0").exists());
    assert!(result["items"].as_array().unwrap().iter().any(|item| {
        item["name"] == format!("generations/{ORPHAN}") && item["outcome"] == "removed"
    }));
    let prior = s.gw.get(&format!("/memory/cleanup/{id}")).await?;
    assert_eq!(prior.data()["phase"], "cancelled");
    assert_eq!(prior.data()["bytes_reclaimed"], bytes);
    s.finish().await
}

// A refused folder cannot expose any management API. The offline driver also
// exercises both library entry points against this predicate without startup.
fn legacy_management_is_unreachable() -> Result<(), HarnessError> {
    let setup = Setup::new("MEM-MANAGE-LEGACY")?;
    let data = &setup.sandbox.data;
    std::fs::create_dir_all(data.join("app-server"))?;
    let file = data.join("app-server/butler-client.sqlite");
    std::fs::write(&file, b"legacy")?;
    let launch = butler_e2e::e2e::agent::Launch::new(&setup.sandbox)?;
    let output = launch
        .command()
        .stdin(std::process::Stdio::null())
        .output()?;
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("legacy data folder is unsupported"));
    assert_eq!(std::fs::read(&file)?, b"legacy");
    assert_eq!(std::fs::read_dir(data)?.count(), 1);
    assert_eq!(std::fs::read_dir(data.join("app-server"))?.count(), 1);
    Ok(())
}

struct CleanupFixture {
    memory: std::path::PathBuf,
    generation: std::path::PathBuf,
    graph_before: Vec<u8>,
    orphan_bytes: Option<u64>,
}

fn seed_dormant(s: &Scenario) -> Result<CleanupFixture, HarnessError> {
    let memory = s.sandbox.data.join("cognition/memory");
    let active: Value =
        serde_json::from_slice(&std::fs::read(memory.join("active-generation.json"))?)?;
    let generation = memory
        .join("generations")
        .join(active["generation_id"].as_str().unwrap());
    let graph_before = std::fs::read(generation.join("graph.sqlite"))?;
    std::fs::create_dir_all(memory.join("rules"))?;
    std::fs::write(memory.join("rules/kept.md"), "Keep concise explanations.")?;
    std::fs::write(
        memory.join("rules/INDEX.md"),
        "- [Keep concise explanations.](kept.md)\n",
    )?;
    std::fs::create_dir_all(memory.join(format!("generations/{ORPHAN}")))?;
    let retired = memory.join(format!("generations/{RETIRED}"));
    std::fs::create_dir_all(retired.join("source-snapshot/runtime"))?;
    std::fs::write(
        retired.join("source-snapshot/runtime/conversation-store.sqlite"),
        vec![1; 8192],
    )?;
    std::fs::write(retired.join("manifest.json"), json!({"schema":"butler.memory-generation.v2",
        "generation_id":RETIRED,"state":"retired","canonical_snapshot_path":"source-snapshot/runtime/conversation-store.sqlite"}).to_string())?;
    std::fs::create_dir_all(memory.join("db"))?;
    std::fs::write(memory.join("db/graph.sqlite"), "legacy source")?;
    std::fs::create_dir_all(memory.join("queue"))?;
    std::fs::write(memory.join("queue/dead-letter.jsonl"), "unresolved")?;
    let orphan_bytes = butler_platform::storage_size::allocated_bytes(
        &memory.join(format!("generations/{ORPHAN}")),
    )?;
    Ok(CleanupFixture {
        memory,
        generation,
        graph_before,
        orphan_bytes,
    })
}

async fn assert_fresh_inventory(s: &Scenario) -> Result<(), HarnessError> {
    let unauthenticated =
        s.gw.http()
            .get(format!("{}/memory/inventory", s.gw.base))
            .send()
            .await?;
    assert_eq!(unauthenticated.status().as_u16(), 401);
    let view = s.gw.get("/memory/inventory").await?;
    assert_eq!(view.status, 200);
    assert_eq!(view.data()["state"], "not_measured");
    assert_eq!(view.data()["kinds"].as_array().unwrap().len(), 4);
    let measured = s.gw.post("/memory/inventory/check", json!({})).await?;
    assert_eq!(measured.status, 200, "{}", measured.text);
    for card in measured.data()["kinds"].as_array().unwrap() {
        assert_eq!(card["item_count"], 0, "{card}");
    }
    Ok(())
}
