//! Scripted Work mutations through the provider boundary, including a later child turn.
use super::super::steward_presentation::stub::{
    call, child_lane, message, review, wire_items, work_id,
};
use axum::{Json, Router, extract::State, response::IntoResponse, routing::post};
use butler_e2e::e2e::{HarnessError, matching, sanitize::Placeholders};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::Notify;

pub(super) const OWNER: &str = "Collect sources, compare options, and write a summary.";
pub(super) const FINISH: &str = "Finish verification and deliver the summary.";
pub(super) const DIRECTION: &str = "Continue the summary and add a verification step.";
pub(super) const KEYS: [&str; 4] = [
    "collect sources",
    "compare options",
    "write summary",
    "verify summary",
];
pub(super) const PURPOSES: [&str; 4] = [
    "Gather the source material",
    "Evaluate the alternatives",
    "Describe the comparison",
    "Check the summary against sources",
];

#[derive(Default)]
pub(super) struct Script {
    first: AtomicUsize,
    next: AtomicUsize,
    finish: AtomicUsize,
    pub(super) workspace: Mutex<String>,
    pub(super) relation: Mutex<String>,
    work: Mutex<String>,
    pub(super) requests: Mutex<Vec<Value>>,
    pub(super) planned: Notify,
    pub(super) accept: Notify,
}

pub(super) async fn start()
-> Result<(String, Arc<Script>, tokio::task::JoinHandle<()>), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}", listener.local_addr()?);
    let script = Arc::new(Script::default());
    let router = Router::new()
        .route("/v1/responses", post(reply))
        .route_layer(axum::middleware::from_fn(
            butler_e2e::e2e::chatgpt_wire::validate,
        ))
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
    let key = matching::key("/v1/responses", &body, &Placeholders::default());
    script.requests.lock().unwrap().push(body.clone());
    let finishing = key.user_request.starts_with(FINISH) && key.user_request != FINISH;
    let later = key.user_request.starts_with(DIRECTION) && key.user_request != DIRECTION;
    let child = child_lane(&body) || later || finishing;
    if !child && crate::connectors::stub::find_spec(&body["input"]).is_some() {
        let response = crate::connectors::stub::run(&body).unwrap();
        return (
            [("content-type", "text/event-stream")],
            response
                .chunks
                .into_iter()
                .map(|c| c.text)
                .collect::<String>(),
        )
            .into_response();
    }
    let item = if child {
        let counter = if finishing {
            &script.finish
        } else if later {
            &script.next
        } else {
            &script.first
        };
        let step = counter.fetch_add(1, Ordering::SeqCst);
        if (!later && !finishing && step == 1) || (later && step == 3) {
            script.planned.notify_one();
            script.accept.notified().await;
        }
        if finishing {
            finish(step, &script)
        } else if later {
            next(step, &script)
        } else {
            first(step, &body, &script)
        }
    } else if key.user_request == OWNER && key.round.is_empty() {
        call(
            "delegate",
            "delegate_to_steward",
            &json!({"request":OWNER,"checks":["Summary matches sources"]}),
        )
    } else if [DIRECTION, FINISH].contains(&key.user_request.as_str()) && key.round.is_empty() {
        call(
            "steer",
            "steer_steward",
            &json!({"relation_id":*script.relation.lock().unwrap(),"instruction":key.user_request}),
        )
    } else if key.user_request.contains("Delegated result") {
        message("Progress received.")
    } else if [OWNER, DIRECTION, FINISH].contains(&key.user_request.as_str()) {
        message("Request received.")
    } else {
        message("{}")
    };
    ([("content-type", "text/event-stream")], wire_items(&[item])).into_response()
}

fn first(step: usize, body: &Value, script: &Script) -> Value {
    match step {
        0 => call("plan-one", "replace_work_plan", &plan(3)),
        1 => call("accept-one", "record_work_review", &review()),
        2 => checkpoint("begin-collection", &[(0, "active")], None),
        3 => read("read-collection", script),
        4 => checkpoint("begin-comparison", &[(0, "done"), (1, "active")], None),
        5 => read("read-comparison", script),
        6 => {
            let work = work_id(body);
            *script.work.lock().unwrap() = work.clone();
            call(
                "pause",
                "record_work_disposition",
                &json!({"work_id":work,"disposition":"blocked",
                "summary":"Comparison saved; summary needs follow-up","action_updates":[],
                "remaining_actions":[KEYS[1],KEYS[2]],"next_condition":"Continue the summary","followups":[]}),
            )
        }
        _ => message("Comparison saved."),
    }
}

fn next(step: usize, script: &Script) -> Value {
    let work = || script.work.lock().unwrap().clone();
    match step {
        0 => call(
            "bad-continuation",
            "continue_work",
            &json!({"work_id":work(),"action_key":"unknown action"}),
        ),
        1 => call(
            "continue-summary",
            "continue_work",
            &json!({"work_id":work(),"action_key":KEYS[2]}),
        ),
        2 => call("plan-two", "replace_work_plan", &plan(4)),
        3 => call(
            "continue-planning",
            "continue_work",
            &json!({"work_id":work(),"action_key":KEYS[3]}),
        ),
        4 => call("accept-two", "record_work_review", &review()),
        5 => checkpoint("bad-checkpoint", &[], Some("unknown action")),
        6 => checkpoint(
            "begin-verification",
            &[(1, "done"), (2, "active"), (3, "active")],
            Some(KEYS[3]),
        ),
        7 => read("read-verification", script),
        // A terminal state followed by active must reset finished_at.
        8 => call(
            "select-summary",
            "record_work_checkpoint",
            &json!({"current_action_key":KEYS[2]}),
        ),
        9 => checkpoint("verification-paused", &[(3, "blocked")], None),
        10 => call(
            "pause-verification",
            "record_work_disposition",
            &json!({"work_id":work(),
            "disposition":"blocked","summary":"Verification needs follow-up","action_updates":[],
            "remaining_actions":[KEYS[2],KEYS[3]],"next_condition":"Finish verification","followups":[]}),
        ),
        _ => message("Verification paused."),
    }
}

fn finish(step: usize, script: &Script) -> Value {
    let work = || script.work.lock().unwrap().clone();
    match step {
        0 => call(
            "continue-verification",
            "continue_work",
            &json!({"work_id":work(),"action_key":KEYS[3]}),
        ),
        1 => checkpoint("verification-resumed", &[(3, "active")], None),
        2 => checkpoint("all-done", &[(2, "done"), (3, "done")], None),
        3 => call(
            "close",
            "record_work_disposition",
            &json!({"work_id":work(),"disposition":"completed",
            "summary":"Summary verified","action_updates":[],"remaining_actions":[],"followups":[]}),
        ),
        _ => message("Summary verified."),
    }
}

fn plan(count: usize) -> Value {
    let actions = (0..count)
        .map(|i| json!({"action_key":KEYS[i],"description":PURPOSES[i],"dependency_keys":[]}))
        .collect::<Vec<_>>();
    json!({"start_new":false,"objective":OWNER,"execution_mode":"direct","governing_refs":[],"actions":actions,"checks":["Summary matches sources"]})
}
fn checkpoint(id: &str, updates: &[(usize, &str)], current: Option<&str>) -> Value {
    let updates = updates
        .iter()
        .map(|(i, status)| json!({"action_key":KEYS[*i],"status":status}))
        .collect::<Vec<_>>();
    let mut args = json!({"public_summary":id,"action_updates":updates});
    if let Some(key) = current {
        args["current_action_key"] = json!(key);
    }
    call(id, "record_work_checkpoint", &args)
}
fn read(id: &str, script: &Script) -> Value {
    call(
        id,
        "read_file",
        &json!({"requests":[{"path":format!("{}/sources.txt",script.workspace.lock().unwrap())}]}),
    )
}
