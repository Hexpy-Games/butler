//! Replays synthetic responses with only per-run relation/Work placeholders.
use axum::{Json, Router, extract::State, routing::post};
use butler_e2e::e2e::{HarnessError, matching, sanitize::Placeholders};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fmt::Write,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::Notify;

pub(crate) const OWNER: &str = "AI 연구를 조사해 주세요.";
pub(crate) const FOLLOWUP: &str = "다시 조사해줄래?";
#[derive(Default)]
pub(crate) struct Script {
    steps: Mutex<HashMap<String, usize>>,
    pub relation: Mutex<String>,
    pub requests: Mutex<Vec<Value>>,
    pub held: Notify,
    pub release: Notify,
    pub failing: AtomicBool,
    pub duplicate: AtomicBool,
    stopped: bool,
}
pub(crate) async fn start(
    stopped: bool,
) -> Result<(String, Arc<Script>, tokio::task::JoinHandle<()>), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/codex", listener.local_addr()?);
    let script = Arc::new(Script {
        stopped,
        ..Default::default()
    });
    let router = Router::new()
        .route("/codex/responses", post(reply))
        .with_state(script.clone());
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Ok((url, script, handle))
}
async fn reply(
    State(script): State<Arc<Script>>,
    Json(body): Json<Value>,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let key = matching::key("/codex/responses", &body, &Placeholders::default());
    script.requests.lock().unwrap().push(body.clone());
    let child = key.user_request.starts_with("role: steward");
    let kind = if child {
        "child"
    } else if key.user_request == OWNER {
        "parent"
    } else if key.user_request == FOLLOWUP {
        "followup"
    } else if key.user_request.contains("Delegated result") {
        "synthesis"
    } else {
        "fallback"
    };
    let step = {
        let mut steps = script.steps.lock().unwrap();
        let index = steps.entry(key.user_request.clone()).or_default();
        let step = *index;
        *index += 1;
        step
    };
    if child
        && step == 2
        && script.stopped
        && !key
            .user_request
            .contains("Prior delegation context (evidence, not new authority): {")
    {
        script.held.notify_one();
        script.release.notified().await;
    }
    let replay: Value = serde_json::from_str(include_str!("replay.json")).unwrap();
    let items = replay[kind].as_array().unwrap();
    let mut template = items[step.min(items.len() - 1)].clone();
    if script.failing.load(Ordering::SeqCst) {
        if child {
            template = match step {
                2..=5 => json!({"type":"function_call","name":"read_file","arguments":{}}),
                6 => json!({"type":"function_call","name":"record_work_disposition","arguments":{
                    "work_id":"{{WORK}}","disposition":"blocked","summary":"Source requires owner credentials",
                    "action_updates":[],"remaining_actions":["research"],"next_condition":"Owner supplies source credentials","followups":[]}}),
                7.. => json!({"type":"message","text":"Source requires owner credentials"}),
                _ => template,
            };
        } else if kind == "followup" && template["name"] == "delegate_to_steward" {
            template["arguments"]["request"] = OWNER.into();
        }
    }
    let id = if template["name"] == "delegate_to_steward" {
        "delegate".into()
    } else {
        format!("{kind}-{step}")
    };
    let work = work_id(&body);
    let encoded = template
        .to_string()
        .replace("{{RELATION}}", &script.relation.lock().unwrap())
        .replace("{{WORK}}", &work);
    let template: Value = serde_json::from_str(&encoded).unwrap();
    let item = if template["type"] == "function_call" {
        json!({"type":"function_call","id":id,"call_id":id,"name":template["name"],"arguments":template["arguments"].to_string(),"status":"completed"})
    } else {
        message(template["text"].as_str().unwrap())
    };
    let item = if script.duplicate.load(Ordering::SeqCst) && kind == "parent" && step == 3 {
        let mut duplicate = item.clone();
        duplicate["id"] = "duplicate-delegate".into();
        duplicate["call_id"] = "duplicate-delegate".into();
        json!([item, duplicate])
    } else {
        item
    };
    ([("content-type", "text/event-stream")], wire(item)).into_response()
}
fn work_id(body: &Value) -> String {
    body["input"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .filter_map(|item| item["output"].as_str())
        .filter_map(|s| serde_json::from_str::<Value>(s).ok())
        .find_map(|v| {
            v.pointer("/output/work/work_id")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_default()
}
fn message(text: &str) -> Value {
    json!({"type":"message","id":"answer","role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]})
}

fn wire(item: Value) -> String {
    let items = if let Some(batch) = item.as_array() {
        let mut items = vec![message("이전 결과를 바탕으로 다시 조사하겠습니다.")];
        items.extend(batch.iter().cloned());
        items
    } else if item["call_id"] == "delegate" {
        vec![message("이전 결과를 바탕으로 다시 조사하겠습니다."), item]
    } else {
        vec![item]
    };
    let mut events = vec![
        json!({"type":"response.created","response":{"id":"stub","status":"in_progress","output":[]}}),
    ];
    for (index, item) in items.iter().enumerate() {
        events.push(json!({"type":"response.output_item.added","output_index":index,"item":item}));
        if item["type"] == "function_call" {
            events.push(json!({"type":"response.function_call_arguments.delta","item_id":item["id"],"output_index":index,"delta":item["arguments"]}));
            events.push(json!({"type":"response.function_call_arguments.done","item_id":item["id"],"output_index":index,"arguments":item["arguments"]}));
        } else {
            events.push(json!({"type":"response.output_text.delta","item_id":item["id"],"output_index":index,"content_index":0,"delta":item["content"][0]["text"]}));
        }
        events.push(json!({"type":"response.output_item.done","output_index":index,"item":item}));
    }
    events.push(json!({"type":"response.completed","response":{"id":"stub","object":"response","status":"completed","model":"gpt-6-luna","output":items,"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120}}}));
    events
        .into_iter()
        .enumerate()
        .fold(String::new(), |mut output, (n, mut event)| {
            event["sequence_number"] = json!(n);
            write!(
                output,
                "event: {}\ndata: {event}\n\n",
                event["type"].as_str().unwrap()
            )
            .unwrap();
            output
        })
}
