//! Replays synthetic responses with only per-run relation/Work placeholders.
use axum::{Json, Router, extract::State, routing::post};
use butler_e2e::e2e::{HarnessError, matching, sanitize::Placeholders};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fmt::Write,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use tokio::sync::Notify;

pub(crate) const OWNER: &str = "AI 연구를 조사해 주세요.";
pub(crate) const FOLLOWUP: &str = "다시 조사해줄래?";
#[derive(Default)]
pub(crate) struct Script {
    steps: Mutex<HashMap<String, usize>>,
    api_history: Mutex<HashMap<String, Vec<Value>>>,
    response_seq: AtomicUsize,
    pub relation: Mutex<String>,
    pub requests: Mutex<Vec<Value>>,
    pub wires: Mutex<Vec<String>>,
    pub ping_headers: Mutex<Vec<String>>,
    pub ping_times: Mutex<Vec<std::time::Instant>>,
    pub fail_ping: AtomicBool,
    pub hold_ping: AtomicBool,
    pub ping_release: Notify,
    pub held: Notify,
    pub release: Notify,
    pub failing: AtomicBool,
    pub duplicate: AtomicBool,
    pub parallel_files: AtomicBool,
    pub terminal_fault: AtomicBool,
    pub file_root: Mutex<String>,
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
    headers: axum::http::HeaderMap,
    wire_body: bytes::Bytes,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let mut body: Value = serde_json::from_slice(&wire_body).unwrap();
    let response_id = format!(
        "stub-{}",
        script.response_seq.fetch_add(1, Ordering::SeqCst)
    );
    let streaming = body["stream"] == true;
    {
        let mut requests = script.requests.lock().unwrap();
        script
            .wires
            .lock()
            .unwrap()
            .push(String::from_utf8(wire_body.to_vec()).unwrap());
        requests.push(body.clone());
    }
    if !streaming {
        let mut history = script.api_history.lock().unwrap();
        let mut input = body["previous_response_id"]
            .as_str()
            .and_then(|id| history.get(id))
            .cloned()
            .unwrap_or_default();
        input.extend(body["input"].as_array().unwrap().iter().cloned());
        history.insert(response_id.clone(), input.clone());
        body["input"] = json!(input);
    }
    let key = matching::key("/codex/responses", &body, &Placeholders::default());
    if body["input"]
        .as_array()
        .and_then(|a| a.last())
        .and_then(|v| v.pointer("/content/0/text"))
        .and_then(Value::as_str)
        .is_some_and(|v| v.starts_with("Cache keepalive."))
    {
        script.ping_headers.lock().unwrap().push(
            headers
                .get_all("session-id")
                .iter()
                .map(|v| v.to_str().unwrap_or_default())
                .collect::<Vec<_>>()
                .join(","),
        );
        script
            .ping_times
            .lock()
            .unwrap()
            .push(std::time::Instant::now());
        if script.fail_ping.load(Ordering::SeqCst) {
            return (
                axum::http::StatusCode::BAD_REQUEST,
                Json(json!({"error":{"code":"invalid_request","message":"Stub ping failure"}})),
            )
                .into_response();
        }
        if script.hold_ping.load(Ordering::SeqCst) {
            script.ping_release.notified().await;
        }
        return respond(message("OK"), Some(80), streaming, &response_id);
    }
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
    if child && step == 3 && script.terminal_fault.load(Ordering::SeqCst) {
        return (axum::http::StatusCode::BAD_REQUEST,
            Json(json!({"error":{"code":"invalid_request","message":"Stub terminal provider failure"}})))
            .into_response();
    }
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
    let replay_step = if child && script.parallel_files.load(Ordering::SeqCst) && step > 2 {
        step - 1
    } else {
        step
    };
    let mut template = items[replay_step.min(items.len() - 1)].clone();
    if script.failing.load(Ordering::SeqCst) {
        if child {
            template = match step {
                2..=5 => {
                    let arguments = if step % 2 == 0 {
                        json!({"alpha":1,"beta":{"left":1,"right":2}})
                    } else {
                        json!({"beta":{"right":2,"left":1},"alpha":1})
                    };
                    json!({"type":"function_call","name":"read_file","arguments":arguments})
                }
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
    let item = if child && script.parallel_files.load(Ordering::SeqCst) && step == 2 {
        json!((0..3).map(|i| json!({"type":"function_call","id":format!("file-{i}"),
            "call_id":format!("file-{i}"),"name":"list_files","status":"completed",
            "arguments":json!({"root":format!("{}/lookup-{i}", script.file_root.lock().unwrap())}).to_string()
        })).collect::<Vec<_>>())
    } else if script.duplicate.load(Ordering::SeqCst) && kind == "parent" && step == 3 {
        let mut duplicate = item.clone();
        duplicate["id"] = "duplicate-delegate".into();
        duplicate["call_id"] = "duplicate-delegate".into();
        json!([item, duplicate])
    } else {
        item
    };
    respond(item, None, streaming, &response_id)
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

fn wire(item: Value, cached: Option<u32>) -> String {
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
    let mut usage = json!({"input_tokens":100,"output_tokens":20,"total_tokens":120});
    if let Some(cached) = cached {
        usage["input_tokens_details"] = json!({"cached_tokens":cached});
    }
    events.push(json!({"type":"response.completed","response":{"id":"stub","object":"response","status":"completed","model":"gpt-6-luna","output":items,"usage":usage}}));
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

fn respond(
    item: Value,
    cached: Option<u32>,
    streaming: bool,
    id: &str,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let encoded = wire(item, cached);
    if streaming {
        return ([("content-type", "text/event-stream")], encoded).into_response();
    }
    let last = encoded
        .lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .next_back()
        .unwrap();
    let event: Value = serde_json::from_str(last).unwrap();
    let mut response = event["response"].clone();
    response["id"] = json!(id);
    Json(response).into_response()
}
