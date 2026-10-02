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

