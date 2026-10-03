//! Deterministic provider for the real parent/child/follow-up path.
use axum::{Json, Router, extract::State, routing::post};
use butler_e2e::e2e::{HarnessError, matching, sanitize::Placeholders};
use serde_json::{Value, json};
use std::{
    fmt::Write,
    sync::{Arc, Mutex},
};
use tokio::sync::Notify;

pub(super) const OWNER: &str = "Delegate reading and comparing a.txt and b.txt.";
pub(super) const DIRECTION: &str = "Use approach B and read b.txt next.";

#[derive(Default)]
pub(super) struct Script {
    steps: Mutex<(usize, usize)>,
    pub relation: Mutex<String>,
    pub workspace: Mutex<String>,
    pub requests: Mutex<Vec<Value>>,
    pub held: Notify,
    pub release: Notify,
}

pub(super) async fn start()
-> Result<(String, Arc<Script>, tokio::task::JoinHandle<()>), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = format!("http://{}/codex", listener.local_addr()?);
    let script = Arc::new(Script::default());
    let router = Router::new()
        .route("/codex/responses", post(reply))
        .with_state(script.clone());
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Ok((address, script, handle))
}

async fn reply(
    State(script): State<Arc<Script>>,
    Json(body): Json<Value>,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let key = matching::key("/codex/responses", &body, &Placeholders::default());
    script.requests.lock().unwrap().push(body.clone());
    let child = key.user_request.starts_with("role: steward");
    if !child
        && key.user_request != OWNER
        && key.user_request != DIRECTION
        && !key.user_request.contains("Delegated result")
    {
        return ([("content-type", "text/event-stream")], wire(message("{}"))).into_response();
    }
    let step = {
        let mut steps = script.steps.lock().unwrap();
        let step = if child { &mut steps.1 } else { &mut steps.0 };
        let current = *step;
        *step += 1;
        current
    };
    if child && step == 4 {
        script.held.notify_one();
        script.release.notified().await;
    }
    let item = if child {
        child_item(step, &body, &script)
    } else if key.user_request == DIRECTION {
        if key.round.is_empty() {
            call(
                "steer",
                "steer_steward",
                &json!({"relation_id":*script.relation.lock().unwrap(),"instruction":DIRECTION}),
            )
        } else {
            message("Direction delivered.")
        }
    } else if key.user_request.contains("Delegated result") {
        message("Approach B verified.")
    } else {
        parent_item(step)
    };
    ([("content-type", "text/event-stream")], wire(item)).into_response()
}

fn parent_item(step: usize) -> Value {
    match step {
        0 => call("start", "start_work", &json!({"objective":OWNER})),
        1 => call("plan", "replace_work_plan", &plan(false, "steward")),
        2 => call("review", "record_work_review", &review()),
        3 => call(
            "delegate",
            "delegate_to_steward",
            &json!({"request":OWNER,"safe_title":"Compare approaches"}),
        ),
        _ => message("Direction delivered."),
    }
}

fn child_item(step: usize, body: &Value, script: &Script) -> Value {
    let path = |name: &str| format!("{}/{}", script.workspace.lock().unwrap(), name);
    match step {
        0 => call("child-plan", "replace_work_plan", &plan(false, "direct")),
        1 => call("child-review", "record_work_review", &review()),
        2 => call(
            "read-a",
            "read_file",
            &json!({"requests":[{"path":path("a.txt") }]}),
        ),
        3 => call(
            "checkpoint",
            "record_work_checkpoint",
            &json!({"public_summary":"Comparing approaches","action_updates":[{"action_key":"read","status":"done"},{"action_key":"compare","status":"active"}]}),
        ),
        4 => call(
            "read-current",
            "read_file",
            &json!({"requests":[{"path":path("a.txt") }]}),
        ),
        5 => call(
            "read-b",
            "read_file",
            &json!({"requests":[{"path":path("b.txt") }]}),
        ),
        6 => call(
            "close",
            "record_work_disposition",
            &json!({"work_id":work_id(body),"disposition":"completed","summary":"Approach B verified","action_updates":[{"action_key":"compare","status":"done"}],"remaining_actions":[],"followups":[]}),
        ),
        _ => message("Approach B verified"),
    }
}

fn work_id(body: &Value) -> String {
    body["input"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .filter_map(|item| item["output"].as_str())
        .filter_map(|output| serde_json::from_str::<Value>(output).ok())
        .find_map(|output| {
            output
                .pointer("/output/work/work_id")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap()
}

fn plan(start_new: bool, mode: &str) -> Value {
    json!({"start_new":start_new,"objective":OWNER,"execution_mode":mode,"governing_refs":[],"actions":[{"action_key":"read","description":"Read source","dependency_keys":[]},{"action_key":"compare","description":"Compare approaches","dependency_keys":["read"]}],"checks":["Approach verified"]})
}
fn review() -> Value {
    json!({"subject":"plan","verdict":"accept","summary":"Ready","corrections":[],"action_updates":[]})
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
