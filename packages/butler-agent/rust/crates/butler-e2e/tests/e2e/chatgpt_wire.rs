//! Request constraints and recovery at the agent's real model route.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
mod models;
use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
};
use butler_e2e::e2e::{
    HarnessError,
    gateway::turn_state,
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
struct Script {
    marker: String,
    mode: String,
    requests: Vec<Value>,
    removed: Option<String>,
}
struct Stub {
    base: String,
    state: Arc<Mutex<Script>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Stub {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Stub {
    async fn start(mode: &str) -> Result<Self, HarnessError> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let base = format!("http://{}/v1", listener.local_addr()?);
        let state = Arc::new(Mutex::new(Script {
            marker: format!("wire-{}", uuid::Uuid::new_v4()),
            mode: mode.into(),
            requests: Vec::new(),
            removed: None,
        }));
        let router = Router::new()
            .route("/v1/responses", post(reply))
            .route_layer(axum::middleware::from_fn(
                butler_e2e::e2e::chatgpt_wire::validate,
            ))
            .with_state(state.clone());
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        Ok(Self { base, state, task })
    }
    fn marker(&self) -> String {
        self.state.lock().unwrap().marker.clone()
    }
    fn requests(&self) -> Vec<Value> {
        self.state.lock().unwrap().requests.clone()
    }
    async fn scenario(&self, id: &str) -> Result<Scenario, HarnessError> {
        Setup::new(id)?
            .env("BUTLER_CHATGPT_API_BASE_URL", &self.base)
            .start()
            .await
    }
}
fn sse(event: &Value) -> Response {
    (
        [("content-type", "text/event-stream")],
        format!("data: {event}\n\n"),
    )
        .into_response()
}
fn success() -> Response {
    sse(
        &json!({"type":"response.completed","response":{"id":"wire-response","model":"gpt-6-sol",
        "output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"wire-ok"}]}],
        "usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}),
    )
}
async fn reply(State(state): State<Arc<Mutex<Script>>>, Json(body): Json<Value>) -> Response {
    let mut state = state.lock().unwrap();
    let key = butler_e2e::e2e::matching::key("/v1/responses", &body, &Default::default());
    if !key
        .user_request
        .starts_with(&butler_e2e::e2e::matching::normalize_volatile(
            &state.marker,
        ))
    {
        return success();
    }
    state.requests.push(body.clone());
    let count = state.requests.len();
    match state.mode.as_str() {
        "401" if count == 1 => (
            StatusCode::UNAUTHORIZED,
            Json(json!({"detail":"identity rejected"})),
        )
            .into_response(),
        "401-twice" => (
            StatusCode::UNAUTHORIZED,
            Json(json!({"detail":"identity rejected"})),
        )
            .into_response(),
        "503" if count == 1 => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"detail":"temporarily unavailable"})),
        )
            .into_response(),
        "403" => (
            StatusCode::FORBIDDEN,
            Json(json!({"error":{"code":"subscription_sharing_user_not_eligible"}})),
        )
            .into_response(),
        "incomplete" => sse(
            &json!({"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}),
        ),
        "cut" => sse(&json!({"type":"response.output_text.delta","delta":"unfinished"})),
        "field" if count == 1 => sse(
            &json!({"type":"response.completed","response":{"id":"warm-call-response","model":"gpt-6-sol",
            "output":[{"type":"function_call","call_id":"warm-call","name":"butler.list_files","arguments":"{\"path\":\".\"}"}]}}),
        ),
        "tool" | "field" | "input" | "twice"
            if (state.mode == "field" && count == 2)
                || (state.mode != "field" && count == 1)
                || state.mode == "twice" =>
        {
            let param = if state.mode == "input" || (state.mode == "twice" && count > 1) {
                "input[0]".into()
            } else if state.mode == "field" {
                let choices = ["text.verbosity", "reasoning.effort", "prompt_cache_key"];
                choices[(uuid::Uuid::new_v4().as_u128() % 3) as usize].to_owned()
            } else {
                let functions = butler_e2e::e2e::chatgpt_wire::function_paths(&body);
                let index = (uuid::Uuid::new_v4().as_u128() % functions.len() as u128) as usize;
                let (path, tool) = &functions[index];
                state.removed = tool["name"].as_str().map(str::to_owned);
                path.clone()
            };
            (StatusCode::BAD_REQUEST,Json(json!({"error":{"code":"subscription_sharing_unsupported_capability","param":param}}))).into_response()
        }
        _ => success(),
    }
}
#[tokio::test]
async fn siwc_10_one_401_refresh_and_retry() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for mode in ["401", "401-twice"] {
        let stub = Stub::start(mode).await?;
        let s = stub
            .scenario(if mode == "401" {
                "SIWC-10-ONCE"
            } else {
                "SIWC-10-TWICE"
            })
            .await?;
        let mut original = super::chatgpt_session::read(&s)?;
        original["earliest_refresh_at"] = i64::MAX.into();
        super::chatgpt_session::write(&s, &original)?;
        let (_, turn) = s.turn("general", &stub.marker()).await?;
        assert_eq!(
            turn_state(&turn),
            if mode == "401" { "delivered" } else { "failed" }
        );
        assert_eq!(stub.requests().len(), 2);
        assert_eq!(
            s.authority
                .as_ref()
                .unwrap()
                .seen()
                .iter()
                .filter(|r| r.path == "token")
                .count(),
            1
        );
        let saved = super::chatgpt_session::read(&s)?;
        assert!(
            saved["access_token"] != original["access_token"],
            "rotation did not replace access_token"
        );
        assert!(saved["sign_in_required"].is_null());
        if mode == "401-twice" {
            assert!(turn.to_string().contains("provider_auth_error"));
        }
        s.finish().await?;
    }
    Ok(())
}
#[tokio::test]
async fn siwc_12_randomized_unsupported_capabilities() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for mode in ["tool", "field", "input", "twice"] {
        let stub = Stub::start(mode).await?;
        let s = stub.scenario(&format!("SIWC-12-{mode}")).await?;
        let (_, turn) = s.turn("general", &stub.marker()).await?;
        let success = mode == "tool" || mode == "field";
        assert_eq!(
            turn_state(&turn),
            if success { "delivered" } else { "failed" },
            "mode={mode}, requests={}, turn={turn}",
            stub.requests().len()
        );
        assert_eq!(
            stub.requests().len(),
            if mode == "input" {
                1
            } else if mode == "field" {
                3
            } else {
                2
            }
        );
        if success {
            assert_ne!(stub.requests()[0], stub.requests()[1]);
            assert_eq!(
                turn_state(
                    &s.turn("general", &format!("{} later", stub.marker()))
                        .await?
                        .1
                ),
                "delivered"
            );
            assert_eq!(stub.requests().len(), if mode == "field" { 4 } else { 3 });
            let removed = stub.state.lock().unwrap().removed.clone();
            if let Some(name) = removed {
                for body in &stub.requests()[1..] {
                    assert!(
                        !butler_e2e::e2e::chatgpt_wire::functions(body)
                            .any(|tool| tool["name"] == name)
                    );
                }
            }
        } else {
            assert!(turn.to_string().contains(if mode == "input" {
                "provider_unsupported_input"
            } else {
                "provider_unsupported_capability"
            }));
        }
        s.finish().await?;
    }
    Ok(())
}
#[tokio::test]
async fn siwc_13_terminal_and_admission_errors() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for (mode, code) in [
        ("incomplete", "provider_response_incomplete"),
        ("cut", "provider_stream_interrupted"),
        ("403", "provider_plan_not_eligible"),
        ("503", ""),
    ] {
        let stub = Stub::start(mode).await?;
        let s = stub.scenario(&format!("SIWC-13-{mode}")).await?;
        let (_, turn) = s.turn("general", &stub.marker()).await?;
        assert_eq!(
            turn_state(&turn),
            if code.is_empty() {
                "delivered"
            } else {
                "failed"
            }
        );
        if code.is_empty() {
            assert_eq!(stub.requests().len(), 2);
        } else {
            assert!(turn.to_string().contains(code), "{turn}");
        }
        s.finish().await?;
    }
    Ok(())
}
#[tokio::test]
async fn siwc_15_discovery_visibility_registration_and_offline_cache() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = super::chatgpt_session::scenario("SIWC-15").await?;
    let authority = s.authority.as_ref().unwrap();
    authority.models(vec![
        json!({"slug":"gpt-6-luna","display_name":"Luna","visibility":"list"}),
        json!({"slug":"gpt-6-sol","display_name":"Sol","visibility":"hide"}),
        json!({"slug":"unlisted-catalog-model","display_name":"Unknown","visibility":"list"}),
    ]);
    authority.faults(butler_e2e::e2e::fake_chatgpt::Faults {
        models_401: 1,
        ..Default::default()
    });
    let catalog = s.gw.get("/model-catalog").await?;
    assert_eq!(
        authority
            .seen()
            .iter()
            .filter(|r| r.path == "models")
            .count(),
        2
    );
    assert_eq!(
        authority
            .seen()
            .iter()
            .filter(|r| r.path == "token")
            .count(),
        1
    );
    assert!(s.sandbox.data.join("cache/chatgpt-models.json").is_file());
    let provider = catalog.data()["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["provider_id"] == "openai")
        .unwrap();
    assert_eq!(provider["chatgpt_plan_models"], json!(["gpt-6-luna"]));
    let refused =
        s.gw.post(
            "/model-catalog/registered-models",
            json!({"provider_id":"openai","model_id":"gpt-6-sol","auth_type":"chatgpt_oauth"}),
        )
        .await?;
    assert_eq!(refused.error_code(), Some("model_not_in_chatgpt_plan"));
    let config_path = s.sandbox.data.join("butler.config.json");
    let mut config: Value = serde_json::from_slice(&std::fs::read(&config_path)?)?;
    config["models"] = json!({"registered":[{"provider_id":"openai","model_id":"gpt-6-sol","auth_type":"codex_oauth"}]});
    std::fs::write(&config_path, serde_json::to_vec(&config)?)?;
    let catalog = s.gw.get("/model-catalog").await?;
    assert_eq!(
        catalog.data()["registered_models"][0]["availability"],
        "not_in_plan"
    );
    models::auto_offline(&s).await?;
    let fetched = authority
        .seen()
        .iter()
        .filter(|r| r.path == "models")
        .count();
    assert_eq!(
        turn_state(&s.turn("general", "models cached turn").await?.1),
        "delivered"
    );
    assert_eq!(
        authority
            .seen()
            .iter()
            .filter(|r| r.path == "models")
            .count(),
        fetched
    );
    authority.stop();
    s.restart().await?;
    let cached = s.gw.get("/model-catalog").await?;
    let provider = cached.data()["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["provider_id"] == "openai")
        .unwrap();
    assert_eq!(provider["chatgpt_plan_models"], json!(["gpt-6-luna"]));
    assert_eq!(
        s.authority
            .as_ref()
            .unwrap()
            .seen()
            .iter()
            .filter(|r| r.path == "models")
            .count(),
        fetched
    );
    s.finish().await
}
