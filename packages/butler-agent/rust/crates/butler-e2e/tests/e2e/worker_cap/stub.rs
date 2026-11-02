//! Deterministic turns; semaphores hold running Workers until the test releases them.
use axum::response::IntoResponse;
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
use tokio::sync::watch;

pub(crate) struct Gate(watch::Sender<bool>);
impl Gate {
    fn new() -> Self {
        Self(watch::channel(false).0)
    }
    pub(crate) fn add_permits(&self, _: usize) {
        self.0.send_replace(true);
    }
    pub(crate) async fn wait(&self) {
        let mut state = self.0.subscribe();
        while !*state.borrow_and_update() {
            state.changed().await.unwrap();
        }
    }
}

pub(crate) struct Script {
    count: usize,
    pub(crate) requests: Mutex<Vec<(String, Value)>>,
    pub(crate) repeat_first: AtomicBool,
    pub(super) wait_regression: AtomicBool,
    pub(crate) repeated_outputs: Mutex<Vec<Value>>,
    pub(crate) steer: AtomicBool,
    pub(crate) hold_continuation: AtomicBool,
    pub(crate) continuation_release: Gate,
    pub(crate) followup: AtomicBool,
    pub(crate) direction: Gate,
    pub(crate) continued: Gate,
    pub(crate) steered: AtomicBool,
    releases: HashMap<String, Gate>,
    pub(crate) started: Mutex<Vec<String>>,
    pub(crate) fourth: Gate,
    pub(crate) waiting_wording: AtomicBool,
    /// The Steward closes its Work instead of waiting for its Worker.
    pub(crate) close_before_worker: AtomicBool,
    pub(crate) hold_worker_report: AtomicBool,
    pub(crate) worker_reporting: Gate,
    pub(crate) worker_report_release: Gate,
}
impl Script {
    pub(crate) fn release(&self, key: &str) {
        self.releases[key].add_permits(1);
    }
}
pub(crate) async fn start(
    count: usize,
) -> Result<(String, Arc<Script>, tokio::task::JoinHandle<()>), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/codex", listener.local_addr()?);
    let script = Arc::new(Script {
        count,
        requests: Default::default(),
        repeat_first: AtomicBool::new(false),
        wait_regression: AtomicBool::new(false),
        repeated_outputs: Default::default(),
        steer: AtomicBool::new(false),
        hold_continuation: AtomicBool::new(false),
        continuation_release: Gate::new(),
        followup: AtomicBool::new(false),
        direction: Gate::new(),
        continued: Gate::new(),
        steered: AtomicBool::new(false),
        releases: ["red", "blue"]
            .into_iter()
            .flat_map(|group| (0..4).map(move |i| (format!("{group}-{i}"), Gate::new())))
            .collect(),
        started: Default::default(),
        fourth: Gate::new(),
        waiting_wording: AtomicBool::new(false),
        close_before_worker: AtomicBool::new(false),
        hold_worker_report: AtomicBool::new(false),
        worker_reporting: Gate::new(),
        worker_report_release: Gate::new(),
    });
    let app = Router::new()
        .route("/codex/responses", post(reply))
        .with_state(script.clone());
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok((url, script, server))
}
async fn reply(
    State(script): State<Arc<Script>>,
    Json(body): Json<Value>,
) -> impl axum::response::IntoResponse {
    let key = matching::key("/codex/responses", &body, &Placeholders::default());
    if crate::connectors::stub::find_spec(&body["input"]).is_some() {
        let response = crate::connectors::stub::run(&body).unwrap();
        let text = response
            .chunks
            .into_iter()
            .map(|c| c.text)
            .collect::<String>();
        return ([("content-type", "text/event-stream")], text).into_response();
    }
    let group = if key.user_request.contains("blue") {
        "blue"
    } else {
        "red"
    };
    let continuation = key.user_request.starts_with("Verify the updated source");
    let role = if key.user_request.starts_with("role: worker") || continuation {
        "worker"
    } else if key.user_request.starts_with("role: steward")
        || body["instructions"]
            .as_str()
            .unwrap_or("")
            .contains("You run one delegated Work for Butler")
    {
        "steward"
    } else {
        "parent"
    };
    script
        .requests
        .lock()
        .unwrap()
        .push((role.into(), body.clone()));
    let index = (0..4)
        .find(|i| key.user_request.contains(&format!("{group}-{i}")))
        .unwrap_or(0);
    let actor = if role == "worker" {
        format!("{group}-{index}")
    } else {
        format!("{group}-{role}")
    };
    let step = key
        .round
        .iter()
        .filter(|kind| kind.as_str() == "function_call_output")
        .count();
    // Repeating arguments is a new tool call, with its own journal identity.
    let response_id = format!("{actor}-{step}");
    let repeat_first = role == "steward" && script.repeat_first.load(Ordering::SeqCst);
    if repeat_first && step == 4 {
        *script.repeated_outputs.lock().unwrap() = body["input"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|item| item["output"].as_str())
            .filter_map(|text| serde_json::from_str::<Value>(text).ok())
            .filter_map(|value| value.get("output").cloned())
            .filter(|output| output["relation_id"].is_string())
            .collect();
    }
    let step = if repeat_first && step >= 3 {
        step - 1
    } else {
        step
    };
    eprintln!("CB-11 provider actor={actor} step={step}");
    if body["input"].as_array().is_some_and(|items| items.iter().any(|item| {
        item["output"].as_str().and_then(|text| serde_json::from_str::<Value>(text).ok()).is_some_and(|value| {
            let output = &value["output"];
            output["status"] == "waiting" && output["delegation_id"].as_str().is_some_and(|id| output["message"] == format!("Worker {id} is waiting because this session already has 2 Workers running. It starts automatically when one of them finishes, and its result arrives like any other. Continue your own work and do not dispatch it again."))
        })
    })) {
        script.waiting_wording.store(true, Ordering::SeqCst);
    }
    if continuation {
        if step == 0 {
            script.continued.add_permits(1);
            if script.hold_continuation.load(Ordering::SeqCst) {
                script.continuation_release.wait().await;
            }
        }
        return (
            [("content-type", "text/event-stream")],
            wire(&worker(step, &body), &format!("continuation-{step}")),
        )
            .into_response();
    }
    if role == "worker" && step == 0 {
        {
            let mut started = script.started.lock().unwrap();
            if !started.contains(&actor) {
                started.push(actor.clone());
            }
        }
        script.releases[&actor].wait().await;
    }
    let steering = script.steer.load(Ordering::SeqCst);
    let step = if role == "steward" && steering && step >= 6 {
        script.steered.store(true, Ordering::SeqCst);
        step - 1
    } else {
        step
    };
    let step = if role == "steward"
        && script.close_before_worker.load(Ordering::SeqCst)
        && step >= script.count + 2
    {
        step + 1
    } else {
        step
    };
    if role == "steward"
        && script.count == 4
        && step == 5
        && (!steering || script.steered.load(Ordering::SeqCst))
    {
        script.fourth.wait().await;
    }
    let item = if script.wait_regression.load(Ordering::SeqCst) {
        super::requires_e2e_fixtures::response(role, &key.user_request, step, script.count, &body)
    } else {
        match role {
            "parent" => parent(step, group),
            "steward" if steering && step == 5 && !script.steered.load(Ordering::SeqCst) => {
                if script.followup.load(Ordering::SeqCst) {
                    script.direction.wait().await;
                }
                let outputs: Vec<_> = body["input"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(|v| v["output"].as_str())
                    .filter_map(|v| serde_json::from_str::<Value>(v).ok())
                    .filter_map(|v| {
                        v.pointer("/output/relation_id")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    })
                    .collect();
                let relation = if script.followup.load(Ordering::SeqCst) {
                    outputs.first()
                } else {
                    outputs.last()
                }
                .unwrap();
                call(
                    "steer_worker",
                    json!({"relation_id":relation,"instruction":"Verify the updated source"}),
                )
            }
            "steward" => steward(
                if key.user_request.starts_with("Delegated result") {
                    step + script.count + 2
                } else {
                    step
                },
                group,
                script.count,
                &body,
            ),
            _ => worker(step, &body),
        }
    };
    if role == "worker"
        && item["type"] == "message"
        && script.hold_worker_report.swap(false, Ordering::SeqCst)
    {
        script.worker_reporting.add_permits(1);
        script.worker_report_release.wait().await;
    }
    (
        [("content-type", "text/event-stream")],
        wire(&item, &response_id),
    )
        .into_response()
}
pub(super) fn parent(step: usize, group: &str) -> Value {
    let objective = format!("Verify batch {group}");
    match step {
        0 => call(
            "delegate_to_steward",
            json!({"request":objective,"checks":["Evidence verified"],"safe_title":objective}),
        ),
        _ => message("Verification delegated."),
    }
}
pub(super) fn steward(step: usize, group: &str, count: usize, body: &Value) -> Value {
    match step {
        0 => call(
            "replace_work_plan",
            plan(&format!("Verify batch {group}"), "workers", count),
        ),
        1 => call("record_work_review", review()),
        n if n < count + 2 => {
            let index = n - 2;
            let objective = format!("Verify {group}-{index}");
            call(
                "delegate_to_worker",
                json!({"action_key":format!("check-{index}"),"objective":objective,"acceptance_criteria":["Evidence verified"],"implementation_brief":objective,"safe_title":objective}),
            )
        }
        n if n == count + 2 => call("wait_for_worker", json!({})),
        n if n == count + 3 => call(
            "record_work_disposition",
            json!({"work_id":work_id(body),"disposition":"completed","summary":"Evidence verified","action_updates":(0..count).map(|i| json!({"action_key":format!("check-{i}"),"status":"done"})).collect::<Vec<_>>(),"remaining_actions":[],"followups":[]}),
        ),
        _ => message("Evidence verified."),
    }
}
pub(super) fn worker(step: usize, body: &Value) -> Value {
    match step {
        0 => call("replace_work_plan", plan("Verify evidence", "direct", 1)),
        1 => call("record_work_review", review()),
        2 => call(
            "record_work_disposition",
            json!({"work_id":work_id(body),"disposition":"completed","summary":"Evidence verified","action_updates":[{"action_key":"check-0","status":"done"}],"remaining_actions":[],"followups":[]}),
        ),
        _ => message("Evidence verified."),
    }
}
fn plan(objective: &str, mode: &str, count: usize) -> Value {
    json!({"objective":objective,"execution_mode":mode,"actions":(0..count).map(|i| json!({"action_key":format!("check-{i}"),"description":"Verify evidence","dependency_keys":[]})).collect::<Vec<_>>(),"checks":["Evidence verified"]})
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
        .filter_map(|v| v["output"].as_str())
        .filter_map(|s| serde_json::from_str::<Value>(s).ok())
        .find_map(|v| {
            v.pointer("/output/work/work_id")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .or_else(|| {
            body["input"].as_array()?.iter().find_map(|item| {
                if item["role"] != "user" {
                    return None;
                }
                let content = match &item["content"] {
                    Value::String(text) => text.clone(),
                    Value::Array(parts) => parts
                        .iter()
                        .filter_map(|p| p["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("\n"),
                    _ => String::new(),
                };
                content.lines().find_map(|line| {
                    line.strip_prefix(
                        "Explicit relation Work id (model-only; never report to user): ",
                    )
                    .map(str::to_owned)
                })
            })
        })
        .unwrap_or_default()
}
fn call(name: &str, args: Value) -> Value {
    let mut output = json!({"type":"function_call","name":name});
    output["arguments"] = args;
    output
}
pub(super) fn message(text: &str) -> Value {
    json!({"type":"message","text":text})
}
fn wire(item: &Value, id: &str) -> String {
    let item = if item["type"] == "function_call" {
        json!({"type":"function_call","id":id,"call_id":id,"name":item["name"],"arguments":item["arguments"].to_string(),"status":"completed"})
    } else {
        json!({"type":"message","id":id,"role":"assistant","status":"completed","content":[{"type":"output_text","text":item["text"],"annotations":[]}]})
    };
    let mut events = vec![
        json!({"type":"response.created","response":{"id":id,"status":"in_progress","output":[]}}),
        json!({"type":"response.output_item.added","output_index":0,"item":item}),
    ];
    if item["type"] == "function_call" {
        events.push(json!({"type":"response.function_call_arguments.delta","item_id":id,"output_index":0,"delta":item["arguments"]}));
        events.push(json!({"type":"response.function_call_arguments.done","item_id":id,"output_index":0,"arguments":item["arguments"]}));
    } else {
        events.push(json!({"type":"response.output_text.delta","item_id":id,"output_index":0,"content_index":0,"delta":item["content"][0]["text"]}));
    }
    events.push(json!({"type":"response.output_item.done","output_index":0,"item":item}));
    events.push(json!({"type":"response.completed","response":{"id":id,"object":"response","status":"completed","model":"gpt-6-luna","output":[item],"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120}}}));
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
