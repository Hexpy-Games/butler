//! Provider-current catalog models must be selectable with their documented wire.
//! https://platform.claude.com/docs/en/build-with-claude/extended-thinking
//! https://docs.x.ai/developers/models/grok-4.3
//! https://www.alibabacloud.com/help/en/model-studio/deep-thinking
#![allow(clippy::unwrap_used, reason = "E2E assertions")]
use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use butler_e2e::e2e::{
    HarnessError,
    config::ModelChoice,
    provider::title_response,
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

type Requests = Arc<Mutex<Vec<Value>>>;
struct Server(tokio::task::JoinHandle<()>);
impl Drop for Server {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn anthropic(State(requests): State<Requests>, Json(body): Json<Value>) -> Response {
    requests.lock().unwrap().push(body.clone());
    if body["thinking"]["type"] == "enabled"
        || body["thinking"].get("budget_tokens").is_some()
        || body.get("budget_tokens").is_some()
        || (body["model"] == "claude-opus-4-7" && body.get("temperature").is_some())
    {
        return (StatusCode::BAD_REQUEST, Json(json!({"type":"error","error":{
            "type":"invalid_request_error","message":"adaptive thinking required; no budget or temperature"}}))).into_response();
    }
    Json(
        json!({"id":"msg_catalog","type":"message","role":"assistant","model":body["model"],
        "content":[{"type":"text","text":"Delivered."}],"stop_reason":"end_turn",
        "usage":{"input_tokens":100,"output_tokens":10}}),
    )
    .into_response()
}

async fn responses(State(requests): State<Requests>, Json(body): Json<Value>) -> Response {
    requests.lock().unwrap().push(body);
    let record = title_response("Delivered.");
    let text: String = record.chunks.into_iter().map(|chunk| chunk.text).collect();
    ([("content-type", "text/event-stream")], text).into_response()
}

async fn chat(State(requests): State<Requests>, Json(body): Json<Value>) -> Response {
    requests.lock().unwrap().push(body.clone());
    let chunk = json!({"id":"chat_catalog","object":"chat.completion.chunk","model":body["model"],
        "choices":[{"index":0,"delta":{"role":"assistant","content":"Delivered."},"finish_reason":null}]});
    let done = json!({"id":"chat_catalog","object":"chat.completion.chunk","model":body["model"],
        "choices":[{"index":0,"delta":{},"finish_reason":"stop"}]});
    (
        [("content-type", "text/event-stream")],
        format!("data: {chunk}\n\ndata: {done}\n\ndata: [DONE]\n\n"),
    )
        .into_response()
}

async fn start() -> Result<(Scenario, Requests, Server), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let base = format!("http://{}/v1", listener.local_addr()?);
    let requests = Requests::default();
    let app = Router::new()
        .route("/v1/messages", post(anthropic))
        .route("/v1/responses", post(responses))
        .route("/v1/chat/completions", post(chat))
        .route("/v1/models", get(|| async { Json(json!({"data":[]})) }))
        .with_state(requests.clone());
    let server = Server(tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    }));
    let s = Setup::new("CATALOG-PROVIDER-TRUTH")?
        .env("BUTLER_ANTHROPIC_BASE_URL", &base)
        .env("BUTLER_XAI_BASE_URL", &base)
        .env("BUTLER_QWEN_BASE_URL", &base)
        .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1")
        .start()
        .await?;
    Ok((s, requests, server))
}

async fn register(s: &Scenario, provider: &str, model: &str) -> Result<(), HarnessError> {
    let saved =
        s.gw.post(
            "/credentials",
            json!({"provider_id":provider,"api_key":"e2e-placeholder"}),
        )
        .await?;
    assert_eq!(saved.status, 201, "{}", saved.text);
    let reply =
        s.gw.post(
            "/model-catalog/registered-models",
            json!({"provider_id":provider,
        "model_id":model,"auth_type":"api_key","credential_id":saved.data()["credential"]["id"]}),
        )
        .await?;
    assert_eq!(reply.status, 201, "{provider}/{model}: {}", reply.text);
    Ok(())
}

async fn turn(
    s: &Scenario,
    model: &str,
    effort: &str,
    requests: &Requests,
) -> Result<Vec<Value>, HarnessError> {
    let selected = s
        .select_model(&ModelChoice {
            model: model.into(),
            effort: Some(effort.into()),
        })
        .await?;
    assert_eq!(selected.status, 200, "{}", selected.text);
    requests.lock().unwrap().clear();
    let (_, reply) = s.turn("general", "Reply briefly.").await?;
    assert_eq!(reply["state"], "delivered", "{reply}");
    let bodies: Vec<_> = requests
        .lock()
        .unwrap()
        .iter()
        .filter(|body| {
            body["tools"]
                .as_array()
                .is_some_and(|tools| !tools.is_empty())
        })
        .cloned()
        .collect();
    assert!(
        !bodies.is_empty(),
        "no tool-bearing turn request reached {model}"
    );
    Ok(bodies)
}

#[tokio::test]
async fn provider_current_models_follow_their_wire_contracts() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, requests, _server) = start().await?;
    reject_multi_agent(&s).await?;
    anthropic_models(&s, &requests).await?;
    grok_model(&s, &requests).await?;
    qwen_model(&s, &requests).await?;
    s.finish().await
}

async fn anthropic_models(s: &Scenario, requests: &Requests) -> Result<(), HarnessError> {
    for (model, effort) in [("claude-opus-4-7", "xhigh"), ("claude-sonnet-4-6", "max")] {
        register(s, "anthropic", model).await?;
        for body in turn(s, &format!("anthropic/{model}"), effort, requests).await? {
            assert_eq!(body["model"], model);
            assert_eq!(body["thinking"]["type"], "adaptive");
            assert_eq!(body["output_config"]["effort"], effort);
            assert!(body["thinking"].get("budget_tokens").is_none());
            assert!(body.get("temperature").is_none());
            assert!(
                body["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|t| t["input_schema"].is_object())
            );
        }
    }
    Ok(())
}

async fn grok_model(s: &Scenario, requests: &Requests) -> Result<(), HarnessError> {
    register(s, "xai", "grok-4.3").await?;
    for body in turn(s, "xai/grok-4.3", "xhigh", requests).await? {
        assert_eq!(body["model"], "grok-4.3");
        assert_eq!(body["reasoning"]["effort"], "xhigh");
        assert!(
            body["tools"]
                .as_array()
                .unwrap()
                .iter()
                .all(|t| t["type"] == "function")
        );
    }
    Ok(())
}

async fn qwen_model(s: &Scenario, requests: &Requests) -> Result<(), HarnessError> {
    register(s, "qwen", "qwen3.6-plus").await?;
    for (effort, enabled) in [("high", true), ("none", false)] {
        for body in turn(s, "qwen/qwen3.6-plus", effort, requests).await? {
            assert_eq!(body["model"], "qwen3.6-plus");
            assert_eq!(body["enable_thinking"], enabled);
            assert!(
                body["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|t| t["type"] == "function")
            );
        }
    }
    Ok(())
}

async fn reject_multi_agent(s: &Scenario) -> Result<(), HarnessError> {
    let saved =
        s.gw.post(
            "/credentials",
            json!({"provider_id":"xai","api_key":"e2e-placeholder"}),
        )
        .await?;
    assert_eq!(saved.status, 201, "{}", saved.text);
    let reply =
        s.gw.post(
            "/model-catalog/registered-models",
            json!({"provider_id":"xai",
        "model_id":"grok-4.20-multi-agent","auth_type":"api_key",
        "credential_id":saved.data()["credential"]["id"]}),
        )
        .await?;
    assert_eq!(reply.status, 400, "{}", reply.text);
    Ok(())
}
