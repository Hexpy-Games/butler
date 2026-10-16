//! Deterministic provider for a Butler → Steward → three Workers assignment.
//! Workers finish one at a time when the test releases them; on every Worker
//! result the Steward first calls `wait_for_worker`, and finishes once the
//! wait reports that no Worker is active.
use super::super::steward_presentation::stub::{call, child_lane, message, review, wire, work_id};
use axum::{Json, Router, extract::State, routing::post};
use butler_e2e::e2e::{HarnessError, matching, sanitize::Placeholders};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::{Notify, watch};

pub(crate) const OWNER: &str = "Check parts A, B and C through workers.";
pub(crate) const PARTS: [&str; 3] = ["A", "B", "C"];
pub(crate) const STEWARD_REPORT: &str = "All three parts checked.";
pub(crate) const BUTLER_REPLY: &str = "Steward report received.";

pub(crate) struct Script {
    pub requests: Mutex<Vec<Value>>,
    /// How many Workers (in `PARTS` order) may finish.
    pub released: watch::Sender<usize>,
    /// Hold the Steward's first round after a `no_active_worker` wait.
    pub hold_after_idle_wait: AtomicBool,
    pub held: Notify,
}

pub(crate) async fn start()
-> Result<(String, Arc<Script>, tokio::task::JoinHandle<()>), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = format!("http://{}/codex", listener.local_addr()?);
    let script = Arc::new(Script {
        requests: Mutex::default(),
        released: watch::Sender::new(0),
        hold_after_idle_wait: AtomicBool::new(false),
        held: Notify::new(),
    });
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
    let outputs = key
        .round
        .iter()
        .filter(|kind| *kind == "function_call_output")
        .count();
    let item = if let Some(part) = worker_part(&key.user_request) {
        let index = PARTS.iter().position(|p| *p == part).unwrap();
        let _ = script
            .released
            .subscribe()
            .wait_for(|released| *released > index)
            .await;
        worker_item(outputs, part, &body)
    } else if child_lane(&body) {
        match steward_item(outputs, &key.user_request, &body, &script) {
            Some(item) => item,
            None => {
                script.held.notify_one();
                return std::future::pending::<axum::response::Response>().await;
            }
        }
    } else {
        butler_item(outputs, &key.user_request)
    };
    ([("content-type", "text/event-stream")], wire(item)).into_response()
}

fn worker_part(request: &str) -> Option<&'static str> {
    let objective = request
        .strip_prefix("role: worker assigned_objective: Check part ")?
        .chars()
        .next()?;
    PARTS.into_iter().find(|part| part.starts_with(objective))
}

fn worker_item(outputs: usize, part: &str, body: &Value) -> Value {
    match outputs {
        0 => call(
            &format!("worker-plan-{part}"),
            "replace_work_plan",
            &plan(&format!("Check part {part}"), "direct", &["check"]),
        ),
        1 => call(
            &format!("worker-review-{part}"),
            "record_work_review",
            &review(),
        ),
        2 => call(
            &format!("worker-close-{part}"),
            "record_work_disposition",
            &close(&work_id(body), &format!("Part {part} checked"), &["check"]),
        ),
        _ => message(&format!("Part {part} checked.")),
    }
}

/// `None` holds the request (the restart scenario's crash point).
fn steward_item(outputs: usize, request: &str, body: &Value, script: &Script) -> Option<Value> {
    let keys: Vec<String> = PARTS.iter().map(|part| format!("part-{part}")).collect();
    let keys: Vec<&str> = keys.iter().map(String::as_str).collect();
    if request.starts_with("role: steward") {
        return Some(match outputs {
            0 => call(
                "steward-plan",
                "replace_work_plan",
                &plan(OWNER, "workers", &keys),
            ),
            1 => call("steward-review", "record_work_review", &review()),
            2..=4 => {
                let part = PARTS[outputs - 2];
                call(
                    &format!("delegate-{part}"),
                    "delegate_to_worker",
                    &json!({"action_key":format!("part-{part}"),"objective":format!("Check part {part}"),
                        "acceptance_criteria":[format!("Part {part} checked")],
                        "implementation_brief":format!("Check part {part} and report it."),
                        "safe_title":format!("Part {part}")}),
                )
            }
            5 => call("steward-wait", "wait_for_worker", &json!({})),
            _ => message("Workers did not report."),
        });
    }
    if !request.starts_with("Delegated result") {
        return Some(message("{}"));
    }
    Some(match outputs {
        0 => call("result-wait", "wait_for_worker", &json!({})),
        1 if last_output(body).contains("no_active_worker") => {
            if script.hold_after_idle_wait.swap(false, Ordering::SeqCst) {
                return None;
            }
            call(
                "steward-close",
                "record_work_disposition",
                &close(&work_id(body), STEWARD_REPORT, &keys),
            )
        }
        1 => message("Still waiting despite the pause."),
        _ => message(STEWARD_REPORT),
    })
}

fn butler_item(outputs: usize, request: &str) -> Value {
    if request.contains("Delegated result") {
        return message(BUTLER_REPLY);
    }
    if request != OWNER {
        return message("{}");
    }
    match outputs {
        0 => call("start", "start_work", &json!({"objective":OWNER})),
        1 => call(
            "plan",
            "replace_work_plan",
            &plan(OWNER, "steward", &["check"]),
        ),
        2 => call("review", "record_work_review", &review()),
        3 => call(
            "delegate-steward",
            "delegate_to_steward",
            &json!({"request":OWNER}),
        ),
        _ => message("Delegated."),
    }
}

/// The newest tool output; with outputs in this round it is this round's.
pub(crate) fn last_output(body: &Value) -> String {
    body["input"]
        .as_array()
        .into_iter()
        .flatten()
        .rev()
        .find(|item| item["type"] == "function_call_output")
        .and_then(|item| item["output"].as_str())
        .unwrap_or_default()
        .to_owned()
}

fn plan(objective: &str, mode: &str, keys: &[&str]) -> Value {
    let actions: Vec<Value> = keys
        .iter()
        .map(|key| json!({"action_key":key,"description":format!("Do {key}"),"dependency_keys":[]}))
        .collect();
    json!({"start_new":false,"objective":objective,"execution_mode":mode,"governing_refs":[],
        "actions":actions,"checks":["Every part checked"]})
}

fn close(work_id: &str, summary: &str, keys: &[&str]) -> Value {
    let updates: Vec<Value> = keys
        .iter()
        .map(|key| json!({"action_key":key,"status":"done"}))
        .collect();
    json!({"work_id":work_id,"disposition":"completed","summary":summary,
        "action_updates":updates,"remaining_actions":[],"followups":[]})
}
