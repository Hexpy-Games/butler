//! Replays synthetic responses with only per-run relation/Work placeholders.
use super::super::work_model_script as native;
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
pub(crate) const MESSAGE: &str = "Check an additional source.";
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
    pub parallel_files: AtomicBool,
    pub terminal_fault: AtomicBool,
    pub file_root: Mutex<String>,
    pub routed: AtomicBool,
    pub blocked: AtomicBool,
    pub hold_revision: AtomicBool,
    pub work: Mutex<String>,
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
    let is_message = key.user_request.starts_with(MESSAGE);
    let child = key.user_request.starts_with("role: steward");
    let kind = if is_message {
        "message"
    } else if child {
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
    if is_message && step == 3 && script.hold_revision.load(Ordering::SeqCst) {
        script.held.notify_one();
        script.release.notified().await;
    }
    let replay: Value = serde_json::from_str(include_str!("replay.json")).unwrap();
    let items = replay[if is_message { "child" } else { kind }]
        .as_array()
        .unwrap();
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
                6 => {
                    json!({"type":"function_call","name":"work_apply","arguments":native::block(&body,"Owner supplies source credentials")})
                }
                7.. => json!({"type":"message","text":"Source requires owner credentials"}),
                _ => template,
            };
        } else if kind == "followup" && step == 0 {
            template =
                json!({"type":"function_call","name":"work_read","arguments":{"view":"tasks"}});
        } else if kind == "followup" && template["name"] == "delegate_to_steward" {
            template["arguments"]["request"] = OWNER.into();
        }
    }
    if script.routed.load(Ordering::SeqCst) && kind == "followup" {
        let instruction = MESSAGE;
        template = if step == 0 {
            json!({"type":"function_call","name":"steer_steward","arguments":{"relation_id":"{{RELATION}}","instruction":instruction}})
        } else {
            json!({"type":"message","text":"Follow-up sent."})
        };
    }
    if script.blocked.load(Ordering::SeqCst) && child && step == 2 {
        template = json!({"type":"function_call","name":"work_apply","arguments":native::block(&body,"Source unavailable")});
    }
    if child && step > 0 {
        *script.work.lock().unwrap() = native::view(&body)["task"]["work_id"]
            .as_str()
            .unwrap_or_default()
            .into();
    }
    if is_message {
        template = message_step(&script, step, &body);
    }
    if kind == "synthesis" && step == 2 {
        template = match native::complete(&body) {
            Some(arguments) => {
                json!({"type":"function_call","name":"work_apply","arguments":arguments})
            }
            None => json!({"type":"message","text":"원문 확인 결과를 정리했습니다."}),
        };
    }
    template = native::fill(template, &body);
    let id = if template["name"] == "delegate_to_steward" {
        "delegate".into()
    } else {
        format!("{kind}-{step}")
    };
    let encoded = template
        .to_string()
        .replace("{{RELATION}}", &script.relation.lock().unwrap());
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
    ([("content-type", "text/event-stream")], wire(item)).into_response()
}
fn message_step(_script: &Script, step: usize, body: &Value) -> Value {
    let read = |args: Value| json!({"type":"function_call","name":"work_read","arguments":args});
    let apply = |args: Value| json!({"type":"function_call","name":"work_apply","arguments":args});
    match step {
        0 => read(json!({"view":"tasks"})),
        1 | 3 => read(json!({"view":"task","task_id":native::task_id(body)})),
        2 => {
            let view = native::view(body);
            let part = native::part(body);
            let mut input = native::apply(
                body,
                json!([{"op":"part.edit","part_id":part,"patch":{"title":"Verify the additional source"},"after_part_ids":if step==2 {vec![part.clone()]}else{vec![]}}]),
            );
            let revision = view["parts"]
                .as_array()
                .unwrap()
                .iter()
                .find(|p| p["id"] == part)
                .unwrap()["revision"]
                .clone();
            input["expected_revisions"] = json!({part.as_str().unwrap():revision});
            apply(input)
        }
        4 => apply(native::submit(body, "Additional source verified")),
        _ => json!({"type":"message","text":"Additional source verified"}),
    }
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
