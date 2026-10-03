//! Shared deterministic stub setup for memory reset E2Es.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E fixture setup")]
use butler_e2e::e2e::fake_servers::LOCAL_MODEL;
use butler_e2e::e2e::scenario::{Fixture, Scenario, Setup};
use butler_e2e::e2e::{HarnessError, fixtures};
use serde_json::{Value, json};
use std::time::Duration;
#[path = "memory_fixture.rs"]
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

pub(super) async fn setup(id: &str) -> Result<Scenario, HarnessError> {
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

pub(super) async fn local_model(s: &Scenario, base: &str) -> Result<String, HarnessError> {
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

pub(super) async fn cycle(s: &mut Scenario) -> Result<(), HarnessError> {
    s.agent.terminate().await?;
    let current = s
        .agent
        .launch
        .env
        .iter()
        .find(|(key, _)| key == "BUTLER_E2E_APP_NOW")
        .unwrap()
        .1
        .clone();
    let later = chrono::DateTime::parse_from_rfc3339(&current).unwrap() + chrono::Duration::days(1);
    s.agent.launch.set_env(
        "BUTLER_E2E_APP_NOW",
        later.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    );
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

pub(super) async fn profile_server() -> Result<(String, tokio::task::JoinHandle<()>), HarnessError>
{
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
