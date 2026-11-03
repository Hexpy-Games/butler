//! A provider whose catalog entry declares json_object output still gets memory extracted.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use butler_e2e::e2e::scenario::{Fixture, Setup};
use butler_e2e::e2e::{HarnessError, fixtures, gateway::turn_state};
use butler_platform::sqlite;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::time::Duration;

struct Server(tokio::task::JoinHandle<()>);
impl Drop for Server {
    fn drop(&mut self) {
        self.0.abort();
    }
}
async fn chat(
    State(bodies): State<Arc<Mutex<Vec<Value>>>>,
    Json(body): Json<Value>,
) -> axum::response::Response {
    bodies.lock().unwrap().push(body.clone());
    if body["response_format"]["type"] == "json_schema" {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":{"message":"This response_format type is unavailable now","type":"invalid_request_error"}}))).into_response();
    }
    let content = if body["response_format"]["type"] == "json_object" {
        r#"{"status":"processed","entities":[],"items":[],"attributes":[]}"#
    } else {
        "Delivered."
    };
    let chunk = json!({"model":body["model"],"choices":[{"delta":{"role":"assistant","content":content},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110}});
    (
        [("content-type", "text/event-stream")],
        format!("data: {chunk}\n\ndata: [DONE]\n\n"),
    )
        .into_response()
}

#[tokio::test]
async fn provider_without_json_schema_still_extracts_memory() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let bodies = Arc::new(Mutex::new(Vec::<Value>::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let base = format!("http://{}/v1", listener.local_addr()?);
    let app = Router::new()
        .route("/v1/chat/completions", post(chat))
        .route(
            "/v1/models",
            get(|| async { Json(json!({"data":[{"id":"deepseek-flash"}]})) }),
        )
        .with_state(bodies.clone());
    let _server = Server(tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    }));
    let setup = Setup::new("STRUCTURED-OUTPUT")?
        .fixture(Fixture::Empty)
        .env("BUTLER_DEEPSEEK_BASE_URL", &base);
    fixtures::scheduler_ran_today(&setup.sandbox.data, fixtures::FIXTURE_TIME)?;
    fixtures::onboarding_complete(&setup.sandbox.data)?;
    std::fs::write(setup.sandbox.data.join("butler.config.json"),
        json!({"models":{"registered":[{"provider_id":"deepseek","model_id":"deepseek-flash","auth_type":"api_key","credential_id":"deepseek-e2e"}]}}).to_string())?;
    std::fs::create_dir_all(setup.sandbox.data.join("auth"))?;
    std::fs::write(setup.sandbox.data.join("auth/model-provider-credentials.json"),
        json!({"credentials":[{"id":"deepseek-e2e","provider_id":"deepseek","auth_type":"api_key","secret":"e2e-placeholder"}]}).to_string())?;
    let s = setup.start().await?;
    let settings =
        s.gw.patch(
            "/settings",
            json!({"model":"deepseek/deepseek-flash","access_mode":"full_access"}),
        )
        .await?;
    assert_eq!(settings.status, 200, "{}", settings.text);
    let (turn_id, turn) = s.turn("general", "Reply with one word.").await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    tokio::time::timeout(Duration::from_secs(30), async {
        let active: Value = serde_json::from_slice(&tokio::fs::read(
            s.sandbox.data.join("cognition/memory/active-generation.json")).await?)?;
        let graph = s.sandbox.data.join("cognition/memory/generations")
            .join(active["generation_id"].as_str().unwrap()).join("graph.sqlite");
        loop {
            let path = graph.clone();
            let source = format!("conversation_turn:{turn_id}");
            let complete = tokio::task::spawn_blocking(move || -> Result<bool, HarnessError> {
                let db = sqlite::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
                Ok(db.query_row("SELECT EXISTS(SELECT 1 FROM memory_chunks c \
                    JOIN memory_projection_jobs j ON j.episode_id=c.memory_chunk_id \
                    WHERE c.source_key=?1 AND json_extract(j.semantic_graph_state,'$.state')='complete')",
                    [source], |row| row.get::<_, bool>(0))?)
            }).await.map_err(|error| butler_e2e::e2e::harness_error(error.to_string()))??;
            if complete { return Ok::<_, HarnessError>(()); }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }).await.expect("memory extraction did not complete")?;
    {
        let bodies = bodies.lock().unwrap();
        let formats = bodies.iter().map(|body| &body["response_format"]["type"]);
        assert!(!formats.clone().any(|format| format == "json_schema"));
        assert!(formats.clone().any(|format| format == "json_object"));
        for body in bodies
            .iter()
            .filter(|body| body["response_format"]["type"] == "json_object")
        {
            let message = &body["messages"][0];
            assert_eq!(message["role"], "system");
            assert!(message["content"].as_str().unwrap().contains("JSON Schema"));
        }
    }
    s.finish().await
}
