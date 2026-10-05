//! Stub provider driving real chat, Work, approval and command execution.
use axum::{Json, Router, extract::State, response::IntoResponse, routing::post};
use butler_e2e::e2e::{HarnessError, cassette::Cassette};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
pub(super) struct Script {
    pub requests: Mutex<Vec<Value>>,
    pub command: String,
    pub elapsed: Mutex<Option<Duration>>,
    started: Mutex<Option<Instant>>,
}

pub(super) async fn start(
    command: &str,
) -> Result<(String, Arc<Script>, tokio::task::JoinHandle<()>), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/codex", listener.local_addr()?);
    let script = Arc::new(Script {
        command: command.into(),
        ..Default::default()
    });
    let router = Router::new()
        .route("/codex/responses", post(reply))
        .with_state(script.clone());
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Ok((url, script, server))
}

async fn reply(
    State(script): State<Arc<Script>>,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let mut requests = script.requests.lock().unwrap();
    let step = requests.len();
    requests.push(body.clone());
    drop(requests);
    let item = if step == 0 {
        *script.started.lock().unwrap() = Some(Instant::now());
        call(
            "observe",
            "run_command",
            &json!({"command":script.command,
            "summary":"다운로드 목록 확인","state_effect":"read_only","output_mode":"full",
            "max_output_tokens":6000,"timeout_ms":30000}),
        )
    } else {
        *script.elapsed.lock().unwrap() = Some(script.started.lock().unwrap().unwrap().elapsed());
        let result = outputs(&body)
            .into_iter()
            .find(|v| v["command"] == script.command);
        let text = if result.as_ref().is_some_and(|v| v["exit_code"] == 0) {
            super::stub::ANSWER
        } else {
            "보호 경로 접근을 거부했습니다."
        };
        json!({"type":"message","id":"msg_answer","role":"assistant","status":"completed",
            "content":[{"type":"output_text","text":text,"annotations":[]}]})
    };
    let wire = super::stub::response(&item).body();
    ([("content-type", "text/event-stream")], wire).into_response()
}

fn call(id: &str, name: &str, args: &Value) -> Value {
    json!({"type":"function_call","id":format!("fc_{id}"),"call_id":format!("call_{id}"),
        "name":name,"arguments":args.to_string(),"status":"completed"})
}

pub(super) fn outputs(body: &Value) -> Vec<Value> {
    body["input"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| item["type"] == "function_call_output")
        .filter_map(|item| serde_json::from_str(item["output"].as_str()?).ok())
        .map(|v: Value| {
            v.get("output")
                .filter(|v| v.is_object())
                .cloned()
                .unwrap_or(v)
        })
        .collect()
}

pub(super) fn cassette() -> Result<Cassette, HarnessError> {
    let mut c = Cassette::load("TOOL-01")?;
    c.meta.model = "openai/gpt-6-luna".into();
    Ok(c)
}
