//! Anthropic wire compatibility through the product gateway and a strict stub.
#![allow(clippy::unwrap_used, reason = "E2E assertions")]
use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    routing::{get, post},
};
use butler_e2e::e2e::{HarnessError, config::ModelChoice, scenario::Setup};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

type Requests = Arc<Mutex<Vec<Value>>>;

async fn reply(
    State(requests): State<Requests>,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    let valid = body["max_tokens"].as_u64().is_some_and(|n| n > 0)
        && body["tools"].as_array().into_iter().flatten().all(|tool| {
            let schema = &tool["input_schema"];
            schema["type"] == "object"
                && ["oneOf", "anyOf", "allOf"]
                    .iter()
                    .all(|key| schema.get(key).is_none())
        });
    requests.lock().unwrap().push(body.clone());
    if !valid {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"type":"error", "error":{
            "type":"invalid_request_error", "message":"integer max_tokens and object input_schema without root combinators required"}})),
        );
    }
    (
        StatusCode::OK,
        Json(
            json!({"id":"msg_compatibility","type":"message","role":"assistant",
        "model":body["model"],"content":[{"type":"text","text":"Compatible request."}],
        "stop_reason":"end_turn","usage":{"input_tokens":100,"output_tokens":10}}),
        ),
    )
}

#[tokio::test]
async fn anthropic_requests_accept_registered_tool_schemas() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let base = format!("http://{}/v1", listener.local_addr()?);
    let requests = Requests::default();
    let app = Router::new()
        .route("/v1/messages", post(reply))
        .route("/v1/models", get(|| async { Json(json!({"data":[]})) }))
        .with_state(requests.clone());
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let s = Setup::new("ANTHROPIC-REQUESTS")?
        .env("BUTLER_ANTHROPIC_BASE_URL", &base)
        .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1")
        .start()
        .await?;
    let saved =
        s.gw.post(
            "/credentials",
            json!({"provider_id":"anthropic",
        "api_key":"sk-ant-e2e-placeholder"}),
        )
        .await?;
    assert_eq!(saved.status, 201, "{}", saved.text);
    let registered =
        s.gw.post(
            "/model-catalog/registered-models",
            json!({
        "provider_id":"anthropic","model_id":"claude-haiku-4-5","auth_type":"api_key",
        "credential_id":saved.data()["credential"]["id"]}),
        )
        .await?;
    assert_eq!(registered.status, 201, "{}", registered.text);
    let selected = s
        .select_model(&ModelChoice {
            model: "anthropic/claude-haiku-4-5".into(),
            effort: None,
        })
        .await?;
    assert_eq!(selected.status, 200, "{}", selected.text);
    requests.lock().unwrap().clear();
    let (_, turn) = s.turn("general", "Reply briefly.").await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let bodies = requests.lock().unwrap().clone();
    assert_ne!(bodies, [] as [serde_json::Value; 0]);
    for body in &bodies {
        assert!(body["max_tokens"].as_u64().is_some());
        let tools = body["tools"].as_array().unwrap();
        assert!(tools.len() >= 35, "only {} tools", tools.len());
        let edit = tools
            .iter()
            .find(|tool| tool["name"] == "edit_file")
            .unwrap();
        assert!(
            edit["description"]
                .as_str()
                .unwrap()
                .contains("Input variant constraints")
        );
        assert!(edit["input_schema"].get("oneOf").is_none());
        assert!(edit["input_schema"]["properties"].get("edits").is_some());
        assert!(edit["input_schema"]["properties"].get("old_text").is_some());
        eprintln!(
            "Anthropic gateway stub: {} tools, integer max_tokens",
            tools.len()
        );
    }
    s.finish().await?;
    server.abort();
    Ok(())
}
