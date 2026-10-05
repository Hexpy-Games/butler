//! Scripted missing-capability regression; all model traffic remains local.
use axum::{Json, Router, extract::State, routing::post};
use butler_e2e::e2e::{HarnessError, matching, sanitize::Placeholders};
use serde_json::{Value, json};
use std::{
    fmt::Write,
    sync::{Arc, Mutex},
};

pub(super) const OWNER: &str =
    "Delegate briefing research, then create a daily 07:00 schedule in this chat.";
pub(super) const ACTION: &str = "예약 작업 등록";
#[derive(Default)]
pub(super) struct Script {
    steps: Mutex<[usize; 3]>,
    parent_work: Mutex<String>,
    pub requests: Mutex<Vec<Value>>,
}
pub(super) fn arguments() -> Value {
    json!({"id":"handoff-briefing","title":"아침 브리핑","prompt":"뉴스와 AI 연구를 조사하고 정리해 주세요.",
        "schedule_type":"interval","interval_minutes":1440,"start_at":"2099-01-01T07:00:00+09:00",
        "session_id":"general"})
}
pub(super) async fn start()
-> Result<(String, Arc<Script>, tokio::task::JoinHandle<()>), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/codex", listener.local_addr()?);
    let script = Arc::new(Script::default());
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
    use axum::response::IntoResponse;
    let key = matching::key("/codex/responses", &body, &Placeholders::default());
    script.requests.lock().unwrap().push(body.clone());
    let lane = if key.user_request.starts_with("role: steward") {
        1
    } else if key.user_request.contains("Delegated result") {
        2
    } else {
        0
    };
    let step = {
        let mut steps = script.steps.lock().unwrap();
        let n = steps[lane];
        steps[lane] += 1;
        n
    };
    if lane == 0 && step == 1 {
        *script.parent_work.lock().unwrap() = work_id(&body);
    }
    let item = match lane {
        1 => child(step, &body),
        2 => recover(step, &body, &script),
        _ => parent(step),
    };
    ([("content-type", "text/event-stream")], wire(item)).into_response()
}
fn parent(step: usize) -> Value {
    match step {
        0 => call("start", "start_work", &json!({"objective":OWNER})),
        1 => call("plan", "replace_work_plan", &plan("steward")),
        2 => call("review", "record_work_review", &review()),
        3 => call(
            "delegate",
            "delegate_to_steward",
            &json!({"request":OWNER,"safe_title":"아침 브리핑 준비"}),
        ),
        _ => message("준비를 시작했습니다."),
    }
}
fn child(step: usize, body: &Value) -> Value {
    match step {
        0 => call("child-plan", "replace_work_plan", &plan("direct")),
        1 => call("child-review", "record_work_review", &review()),
        2 => search(),
        3 => describe(),
        4 => call(
            "handoff",
            "record_work_disposition",
            &json!({
                "work_id":work_id(body),"disposition":"blocked","summary":"Parent capability required.",
                "remaining_actions":[ACTION],"action_updates":[{"action_key":ACTION,"status":"blocked"}],
                "capability_handoff":{"code":"capability_unavailable_in_child",
                    "requested_action":{"tool_name":"create_automation","arguments":arguments()}}
            }),
        ),
        _ => message("Parent capability required."),
    }
}
fn recover(step: usize, body: &Value, script: &Script) -> Value {
    match step {
        // Runtime must reject a prose-only failure and continue this same Turn.
        0 => message("예약을 등록하지 못했습니다."),
        1 => call(
            "resume",
            "continue_work",
            &json!({"work_id":*script.parent_work.lock().unwrap()}),
        ),
        2 => call("recover-plan", "replace_work_plan", &plan("direct")),
        3 => call("recover-review", "record_work_review", &review()),
        4 => search(),
        5 => describe(),
        6 => call(
            "create",
            "tool_call",
            &json!({"id":"native:create_automation","arguments":arguments()}),
        ),
        7 => call(
            "settle",
            "record_work_disposition",
            &json!({"work_id":work_id(body),
            "disposition":"completed","summary":"예약 작업 등록 완료",
            "action_updates":[{"action_key":ACTION,"status":"done"}],"remaining_actions":[]}),
        ),
        _ => message("예약 작업을 등록했습니다."),
    }
}
fn search() -> Value {
    call("search", "tool_search", &json!({"query":"schedule"}))
}
fn describe() -> Value {
    call(
        "describe",
        "tool_describe",
        &json!({"ids":["native:create_automation"]}),
    )
}
fn plan(mode: &str) -> Value {
    json!({"objective":OWNER,"execution_mode":mode,
        "actions":[{"action_key":ACTION,"effect":{"capability":"create_automation","target":"general"}}],
        "checks":["예약 작업이 저장되어야 합니다."]})
}
fn review() -> Value {
    json!({"subject":"plan","verdict":"accept","summary":"Ready"})
}
fn work_id(body: &Value) -> String {
    body["input"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find_map(|item| {
            if item["type"] == "function_call_output" {
                let output: Value = serde_json::from_str(item["output"].as_str()?).ok()?;
                output["work"]["work_id"].as_str().map(str::to_owned)
            } else {
                item["content"].as_array()?.iter().find_map(|part| {
                    part["text"].as_str()?.lines().find_map(|line| {
                        line.strip_prefix(
                            "Explicit relation Work id (model-only; never report to user): ",
                        )
                        .map(str::to_owned)
                    })
                })
            }
        })
        .unwrap()
}
fn call(id: &str, name: &str, args: &Value) -> Value {
    json!({"type":"function_call","id":id,"call_id":id,"name":name,"arguments":args.to_string(),"status":"completed"})
}
fn message(text: &str) -> Value {
    json!({"type":"message","id":"answer","role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]})
}

fn wire(item: Value) -> String {
    let items = if item["call_id"] == "delegate" {
        vec![message("I'll compare both approaches."), item]
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
