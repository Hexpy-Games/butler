//! Stub provider driving real chat, Work, approval and command execution.
use axum::{Json, Router, extract::State, response::IntoResponse, routing::post};
use butler_e2e::e2e::{HarnessError, cassette::Cassette};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub(super) struct Script {
    pub requests: Mutex<Vec<Value>>,
    pub command: String,
    retry_observation: bool,
}

pub(super) async fn start(
    command: &str,
    retry_observation: bool,
) -> Result<(String, Arc<Script>, tokio::task::JoinHandle<()>), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/codex", listener.local_addr()?);
    let script = Arc::new(Script {
        command: command.into(),
        retry_observation,
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
    let item = if script.retry_observation && step == 0 {
        call(
            "preflight",
            "run_command",
            &json!({"command":script.command,"summary":"다운로드 목록 확인","state_effect":"read_only"}),
        )
    } else {
        match step - usize::from(script.retry_observation) {
            0 => call(
                "start",
                "start_work",
                &json!({"objective": super::stub::PROMPT}),
            ),
            1 => call(
                "plan",
                "replace_work_plan",
                &json!({"objective":"Inspect Downloads and propose a plan",
            "execution_mode":"direct","actions":[{"action_key":"inspect", "effect":{
                "capability":"run_command","target":"workspace-command:."}}],
            "checks":["Non-recursive listing; no files changed"]}),
            ),
            2 => call(
                "review",
                "record_work_review",
                &json!({"subject":"plan","verdict":"accept",
            "summary":"Read-only inspection; no moves","action_updates":[{"action_key":"inspect","status":"active"}]}),
            ),
            3 => call(
                "observe",
                "run_command",
                &json!({"command":script.command,
            "summary":"다운로드 목록 확인","state_effect":"read_only","output_mode":"full","timeout_ms":30000}),
            ),
            4 => {
                let work = outputs(&body)
                    .into_iter()
                    .find_map(|v| v["work"]["work_id"].as_str().map(str::to_owned))
                    .unwrap();
                call(
                    "close",
                    "record_work_disposition",
                    &json!({"work_id":work,"disposition":"completed",
                "summary":"Inspection completed; no files changed","action_updates":[{"action_key":"inspect","status":"done"}],
                "remaining_actions":[],"followups":[]}),
                )
            }
            _ => {
                let result = outputs(&body)
                    .into_iter()
                    .find(|v| v["command"] == script.command);
                let text = if result.as_ref().is_some_and(|v| v["exit_code"] == 0) {
                    super::stub::ANSWER
                } else {
                    "보호 경로 접근을 거부했습니다."
                };
                json!({"type":"message","id":"msg_answer","role":"assistant","status":"completed",
                "content":[{"type":"output_text","text":text,"annotations":[]} ]})
            }
        }
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
