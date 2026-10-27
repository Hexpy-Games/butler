//! Deterministic provider for the real parent/child/follow-up path.
use axum::{Json, Router, extract::State, routing::post};
use butler_e2e::e2e::{HarnessError, matching, sanitize::Placeholders};
use serde_json::{Value, json};
use std::{
    fmt::Write,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use tokio::sync::Notify;

pub(crate) const OWNER: &str = "Delegate reading and comparing a.txt and b.txt.";
pub(crate) const DIRECTION: &str = "Use approach B and read b.txt next.";
pub(crate) const DIRECTION_2: &str = "Also compare a.txt line by line.";

pub(crate) const HOLD_PARENT: &str = "Keep this turn open while the work runs.";
pub(crate) const QUEUED: &str = "Note the status for later.";
pub(crate) const QUEUED_REPLY: &str = "Status noted.";

#[derive(Default)]
pub(crate) struct Script {
    pub(crate) answer_blocks: AtomicBool,
    pub(crate) direction_effect: Mutex<Option<Value>>,
    pub(crate) deliverables: AtomicBool,
    answer_step: Mutex<usize>,
    pub(crate) browser: AtomicBool,
    pub open_disposition: AtomicBool,
    pub blocked_disposition: AtomicBool,
    steps: Mutex<(usize, usize)>,
    pub relation: Mutex<String>,
    pub workspace: Mutex<String>,
    pub requests: Mutex<Vec<Value>>,
    pub held: Notify,
    pub parent_held: Notify,
    pub hold_seen: AtomicUsize,
    pub release: Notify,
    pub hold_direction: AtomicBool,
    pub direction_held: Notify,
}

pub(crate) async fn start()
-> Result<(String, Arc<Script>, tokio::task::JoinHandle<()>), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = format!("http://{}", listener.local_addr()?);
    let script = Arc::new(Script::default());
    let router = Router::new()
        .route("/v1/responses", post(reply))
        .route_layer(axum::middleware::from_fn(
            butler_e2e::e2e::chatgpt_wire::validate,
        ))
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
    let key = matching::key("/v1/responses", &body, &Placeholders::default());
    script.requests.lock().unwrap().push(body.clone());
    let child = child_lane(&body);
    if !child && crate::connectors::stub::find_spec(&body["input"]).is_some() {
        let response = crate::connectors::stub::run(&body).unwrap();
        let wire = response
            .chunks
            .into_iter()
            .map(|c| c.text)
            .collect::<String>();
        return ([("content-type", "text/event-stream")], wire).into_response();
    }
    if child
        && script.hold_direction.load(Ordering::SeqCst)
        && key.user_request.starts_with(DIRECTION)
    {
        script.direction_held.notify_one();
        return std::future::pending::<axum::response::Response>().await;
    }
    if !child && key.user_request == HOLD_PARENT {
        script.hold_seen.fetch_add(1, Ordering::SeqCst);
        script.parent_held.notify_one();
        return std::future::pending::<axum::response::Response>().await;
    }
    if !child && key.user_request == QUEUED {
        return (
            [("content-type", "text/event-stream")],
            wire(message(QUEUED_REPLY)),
        )
            .into_response();
    }
    if !child
        && key.user_request != OWNER
        && key.user_request != DIRECTION
        && key.user_request != DIRECTION_2
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
    if child && step == 4 && !script.browser.load(Ordering::SeqCst) {
        script.held.notify_one();
        script.release.notified().await;
    }
    let item = if child {
        child_item(step, &body, &script)
    } else if key.user_request == DIRECTION || key.user_request == DIRECTION_2 {
        if key.round.is_empty() {
            let id = if key.user_request == DIRECTION {
                "steer"
            } else {
                "steer-2"
            };
            call(
                id,
                "steer_steward",
                &json!({"relation_id":*script.relation.lock().unwrap(),"instruction":key.user_request}),
            )
        } else {
            message("Direction delivered.")
        }
    } else if key.user_request.contains("Delegated result")
        && script.open_disposition.load(Ordering::SeqCst)
    {
        message("Delegated work could not complete; progress remains saved.")
    } else if key.user_request.contains("Delegated result")
        && script.answer_blocks.load(Ordering::SeqCst)
    {
        super::super::browser_delegation::answer::parent_item(
            &body,
            &mut script.answer_step.lock().unwrap(),
        )
    } else if key.user_request.contains("Delegated result") {
        message("Approach B verified.")
    } else {
        parent_item(step, script.answer_blocks.load(Ordering::SeqCst))
    };
    ([("content-type", "text/event-stream")], wire(item)).into_response()
}

pub(crate) fn user_text(item: &Value) -> String {
    matching::user_request(&raw_text(item), &Placeholders::default())
}

fn raw_text(item: &Value) -> String {
    match &item["content"] {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| part["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

pub(crate) fn child_lane(body: &Value) -> bool {
    body["input"].as_array().into_iter().flatten().any(|item| {
        item["role"] == "user"
            && (user_text(item).starts_with("role: steward")
                || raw_text(item).lines().any(|line| {
                    line.starts_with("Original request (highest priority): role: steward")
                }))
    })
}

/// With `presented`, the parent Plan decides to show the result as cards and
/// a table, which the delegated task then carries.
fn parent_item(step: usize, presented: bool) -> Value {
    let mut checks = vec![
        "Approach verified",
        REVISED_CHECK,
        "Goal: Choose the better approach for the owner's next step",
        "Deliver: A one-line recommendation",
        "Next: Apply the chosen approach",
        "Assumed: Both files are current",
    ];
    if presented {
        checks.push("Presentation: cards, table");
    }
    match step {
        0 => call(
            "delegate",
            "delegate_to_steward",
            &json!({"request":OWNER,"checks":checks}),
        ),
        _ => message("Direction delivered."),
    }
}

fn child_item(step: usize, body: &Value, script: &Script) -> Value {
    if step == 4
        && let Some(effect) = script.direction_effect.lock().unwrap().clone()
    {
        return call("direction-effect", "run_command", &effect);
    }
    let directed = script.direction_effect.lock().unwrap().is_some();
    if directed && step == 6 {
        return call("direction-plan-review", "record_work_review", &review());
    }
    let step = if directed && step > 6 { step - 1 } else { step };
    // Only the butler answers the user; a steward reports to it.
    let offered = butler_e2e::e2e::chatgpt_wire::functions(body);
    assert!(
        !offered
            .into_iter()
            .any(|tool| tool["name"] == "answer_blocks"),
        "a steward was offered answer_blocks"
    );
    // Two collections: both succeed for an answer; otherwise the second is
    // refused so its recovery reaches the steward.
    let collecting = 2;
    if script.browser.load(Ordering::SeqCst) && (7..7 + collecting).contains(&step) {
        return call(
            &format!("collect-browser-{step}"),
            "tool_call",
            &json!({"id":"native:image_collect","arguments":{"tab":"parent-tab","ref":format!("image-ref-{step}"),"observation":"parent-observation"}}),
        );
    }
    let step = if script.browser.load(Ordering::SeqCst) && step >= 7 + collecting {
        step - collecting
    } else {
        step
    };
    if script.browser.load(Ordering::SeqCst) {
        let presents_answer_blocks = script.answer_blocks.load(Ordering::SeqCst);
        if presents_answer_blocks && (7..10).contains(&step) {
            return match step {
                7 => call(
                    "open-other-page",
                    "tool_call",
                    &json!({"id":"native:browser_open","arguments":{"url":"https://example.org/"}}),
                ),
                8 => call(
                    "observe-other-page",
                    "tool_call",
                    &json!({"id":"native:browser_observe","arguments":{"tab":"other-tab"}}),
                ),
                _ => call(
                    "capture-other-page",
                    "tool_call",
                    &json!({"id":"native:browser_screenshot","arguments":{"tab":"other-tab","observation":"other-observation"}}),
                ),
            };
        }
        let step = if presents_answer_blocks && step >= 10 {
            step - 3
        } else {
            step
        };
        return match step {
            0 => call("browser-plan", "replace_work_plan", &plan(false, "direct")),
            1 => call("browser-review", "record_work_review", &review()),
            2 => call(
                "describe-browser",
                "tool_describe",
                &json!({"ids":["native:browser_open","native:browser_tabs","native:browser_observe","native:browser_screenshot","native:image_collect"]}),
            ),
            3 => call(
                "open-browser",
                "tool_call",
                &json!({"id":"native:browser_open","arguments":{"url":"https://example.com/"}}),
            ),
            4 => call(
                "list-browser",
                "tool_call",
                &json!({"id":"native:browser_tabs","arguments":{}}),
            ),
            5 => call(
                "observe-browser",
                "tool_call",
                &json!({"id":"native:browser_observe","arguments":{"tab":"parent-tab"}}),
            ),
            6 => call(
                "capture-browser",
                "tool_call",
                &json!({"id":"native:browser_screenshot","arguments":{"tab":"parent-tab","observation":"parent-observation"}}),
            ),
            7 => {
                let mut wrong = work_id(body);
                wrong.pop();
                call(
                    "wrong-browser-work",
                    "record_work_disposition",
                    &json!({"work_id":wrong,"disposition":"completed","summary":"Browser verified"}),
                )
            }
            8 => call(
                "wrong-browser-continuation",
                "continue_work",
                &json!({"work_id":format!("{}-wrong",work_id(body))}),
            ),
            9 => call(
                "close-browser-work",
                "record_work_disposition",
                &json!({"work_id":work_id(body),"disposition":"completed","summary":"Browser verified",
                    "action_updates":[{"action_key":"read","status":"done"},{"action_key":"compare","status":"done"}],
                    "remaining_actions":[],"followups":[]}),
            ),
            _ => message("Browser verified."),
        };
    }
    if script.deliverables.load(Ordering::SeqCst) && step >= 6 {
        return super::super::deliverables::delegation::child(step, &work_id(body));
    }
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
        6 if script.blocked_disposition.load(Ordering::SeqCst) => call(
            "close-blocked",
            "record_work_disposition",
            &json!({"work_id":work_id(body),"disposition":"blocked","summary":"Research delivered; follow-up remains",
                "action_updates":[],"remaining_actions":["compare"],"next_condition":"Owner follow-up","followups":[]}),
        ),
        6 if script.open_disposition.load(Ordering::SeqCst) => call(
            "close-open",
            "record_work_disposition",
            &json!({"work_id":work_id(body),"disposition":"open","summary":"Comparison remains unfinished",
                "action_updates":[],"remaining_actions":["compare"],"next_condition":"Continue comparing approaches","followups":[]}),
        ),
        6 => call(
            "write-report",
            "write_file",
            &json!({"path":"report.html","content":"<!doctype html>\n<title>Approach B</title>\n"}),
        ),
        7..=11 if script.open_disposition.load(Ordering::SeqCst) => {
            message("Comparison remains unfinished.")
        }
        7 | 12 => call(
            "close",
            "record_work_disposition",
            &json!({"work_id":work_id(body),"disposition":"completed","summary":"Approach B verified","action_updates":[{"action_key":"compare","status":"done"}],"remaining_actions":[],"followups":[]}),
        ),
        _ => message("Approach B verified: 키센스.txt"),
    }
}

pub(crate) fn work_id(body: &Value) -> String {
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
        .or_else(|| {
            body["input"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|item| item["role"] == "user")
                .find_map(|item| {
                    raw_text(item).lines().find_map(|line| {
                        line.strip_prefix(
                            "Explicit relation Work id (model-only; never report to user): ",
                        )
                        .map(str::to_owned)
                    })
                })
        })
        .unwrap()
}

fn plan(start_new: bool, mode: &str) -> Value {
    json!({"start_new":start_new,"objective":OWNER,"execution_mode":mode,"governing_refs":[],"actions":[{"action_key":"read","description":"Read source","dependency_keys":[]},{"action_key":"compare","description":"Compare approaches","dependency_keys":["read"]}],"checks":["Approach verified"]})
}
pub(crate) const REVISED_CHECK: &str = "Comparison names its deciding criterion";

pub(crate) fn review() -> Value {
    json!({"subject":"plan","verdict":"accept","summary":"Ready","corrections":[],"action_updates":[]})
}
pub(crate) fn call(id: &str, name: &str, args: &Value) -> Value {
    json!({"type":"function_call","id":id,"call_id":id,"name":name,"arguments":args.to_string(),"status":"completed"})
}
pub(crate) fn message(text: &str) -> Value {
    json!({"type":"message","id":"answer","role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]})
}

fn wire(item: Value) -> String {
    if item["call_id"] == "delegate" {
        wire_items(&[message("I'll compare both approaches."), item])
    } else {
        wire_items(&[item])
    }
}

/// One streamed reply carrying `items` in order, such as a batch of calls.
pub(crate) fn wire_items(items: &[Value]) -> String {
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
