//! Profile imports retain the complete accepted export and reach the next turn.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
use super::memory_reset_support as support;
use axum::{Json, Router, extract::State, response::IntoResponse, routing::post};
use butler_e2e::e2e::HarnessError;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
const FACT: &str = "한국어 존댓말과 간결한 답변을 선호합니다.";
type Requests = Arc<Mutex<Vec<Value>>>;

async fn reply(
    State(requests): State<Requests>,
    Json(input): Json<Value>,
) -> axum::response::Response {
    requests.lock().unwrap().push(input.clone());
    let messages = input["messages"].as_array().unwrap();
    let prompt = messages
        .iter()
        .filter_map(|m| m["content"].as_str())
        .find(|text| text.contains("Import ref: "));
    let text = if let Some(prompt) = prompt {
        let reference = prompt
            .lines()
            .find_map(|line| line.strip_prefix("Import ref: "))
            .unwrap();
        let candidates = if prompt.contains(FACT) {
            vec![
                json!({"category":"communication","summary":FACT,"source_type":"explicit",
                "confidence":"high","evidence_refs":[reference],"butler_should":[FACT]}),
            ]
        } else {
            vec![]
        };
        json!({"candidates":candidates}).to_string()
    } else {
        "Understood.".into()
    };
    if input["stream"] == true {
        let chunk = json!({"id":"stub","object":"chat.completion.chunk","model":"stub",
            "choices":[{"index":0,"delta":{"role":"assistant","content":text},"finish_reason":null}]});
        let end = json!({"id":"stub","object":"chat.completion.chunk","model":"stub",
            "choices":[{"index":0,"delta":{},"finish_reason":"stop"}]});
        (
            [("content-type", "text/event-stream")],
            format!("data: {chunk}\n\ndata: {end}\n\ndata: [DONE]\n\n"),
        )
            .into_response()
    } else {
        Json(json!({"id":"stub","object":"chat.completion","model":"stub",
            "choices":[{"index":0,"message":{"role":"assistant","content":text},"finish_reason":"stop"}]})).into_response()
    }
}

#[tokio::test]
async fn profile_import_retains_tail_and_rejects_oversize_without_writes()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let requests = Requests::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let base = format!("http://{}", listener.local_addr()?);
    let router = Router::new()
        .route("/v1/chat/completions", post(reply))
        .with_state(requests.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let s = support::setup("MEM-IMPORT-COMPLETE").await?;
    let model = support::local_model(&s, &base).await?;
    s.gw.patch(
        "/personalization",
        json!({"profiling":{"mode":"basic","extractor_model":model}}),
    )
    .await?;
    let export = format!(
        "{}{}",
        "x".repeat(60_000 - FACT.encode_utf16().count()),
        FACT
    );
    let imported =
        s.gw.post("/personalization/profile-import", json!({"text":export}))
            .await?;
    assert_eq!(imported.status, 200, "{}", imported.text);
    assert_eq!(
        imported.data()["stable_entry_count"],
        1,
        "{}",
        imported.text
    );
    assert_eq!(imported.data()["promoted_count"], 1);
    assert_eq!(imported.data()["projection_written"], true);
    let captured = requests.lock().unwrap().clone();
    assert!(
        captured.iter().any(|v| v.to_string().contains(&export)),
        "accepted export was truncated"
    );
    for text in [
        "x".repeat(60_001),
        "🙂".repeat(30_001),
        "x".repeat(1_100_000),
    ] {
        let rejected =
            s.gw.post("/personalization/profile-import", json!({"text":text}))
                .await?;
        assert_eq!(rejected.status, 413, "{}", rejected.text);
        let error: Value = serde_json::from_str(&rejected.text)?;
        assert!(error["error"]["code"].is_string(), "{}", rejected.text);
    }
    assert_eq!(
        requests.lock().unwrap().len(),
        captured.len(),
        "rejected imports called the model"
    );
    let empty =
        s.gw.post("/personalization/profile-import", json!({"text":"   "}))
            .await?;
    assert_eq!(empty.data()["stable_entry_count"], 1);
    assert_eq!(empty.data()["model_called"], false);
    let inventory = s.gw.post("/memory/inventory/check", json!({})).await?;
    let kinds = inventory.data()["kinds"].as_array().unwrap();
    assert_eq!(
        kinds.iter().find(|v| v["kind"] == "profile").unwrap()["item_count"],
        1
    );
    assert_eq!(
        s.turn("general", "Please use my saved answer preferences.")
            .await?
            .1["state"],
        "delivered"
    );
    assert!(
        requests
            .lock()
            .unwrap()
            .iter()
            .any(|v| v["stream"] == true && v.to_string().contains(FACT)),
        "next turn omitted the imported profile"
    );
    let result = s.finish().await;
    server.abort();
    result
}
