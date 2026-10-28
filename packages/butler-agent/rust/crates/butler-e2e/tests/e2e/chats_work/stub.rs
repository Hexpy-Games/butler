//! Stub decisions use role tool lists, call results and call ids, never prompt prose.
use super::*;
use crate::steward_presentation::stub::{call, message, wire_items, work_id};
use axum::{Json, Router, extract::State, response::IntoResponse, routing::post};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::Semaphore;

pub(crate) struct Script {
    pub requests: Mutex<Vec<Value>>,
    pub delegated: AtomicBool,
    pub unattended: bool,
    pub tier: AtomicBool,
    pub file_actions: AtomicBool,
    pub result_mutation: AtomicBool,
    pub resume_probe: AtomicBool,
    pub child: bool,
    pub hold: AtomicBool,
    pub held: Semaphore,
    pub parent_hold: AtomicBool,
    pub parent_held: Semaphore,
    pub parent_release: Semaphore,
    pub release: Semaphore,
    pub relation: Mutex<String>,
}

pub(crate) async fn start(
    unattended: bool,
    child: bool,
) -> Result<(String, Arc<Script>, tokio::task::JoinHandle<()>), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/v1", listener.local_addr()?);
    let script = Arc::new(Script {
        requests: Mutex::default(),
        delegated: AtomicBool::new(false),
        unattended,
        child,
        tier: AtomicBool::new(false),
        file_actions: AtomicBool::new(false),
        result_mutation: AtomicBool::new(false),
        resume_probe: AtomicBool::new(false),
        hold: AtomicBool::new(!unattended),
        held: Semaphore::new(0),
        parent_hold: AtomicBool::new(false),
        parent_held: Semaphore::new(0),
        parent_release: Semaphore::new(0),
        release: Semaphore::new(0),
        relation: Mutex::default(),
    });
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

async fn reply(State(script): State<Arc<Script>>, Json(body): Json<Value>) -> impl IntoResponse {
    script.requests.lock().unwrap().push(body.clone());
    let functions: Vec<_> = butler_e2e::e2e::chatgpt_wire::functions(&body).collect();
    let parent = functions.iter().any(|f| {
        matches!(
            f["name"].as_str(),
            Some("delegate_to_steward" | "answer_blocks")
        )
    });
    let outputs = outputs(&body);
    let step = outputs.len();
    let item = if script.result_mutation.load(Ordering::SeqCst) {
        if step == 0 {
            call(
                "result-write",
                "write_file",
                &json!({"path":"notice.txt","content":"changed"}),
            )
        } else {
            message("Evidence ready.")
        }
    } else if functions.is_empty() {
        message("{}")
    } else if parent {
        if step == 0 && script.parent_hold.swap(false, Ordering::SeqCst) {
            script.parent_held.add_permits(1);
            script.parent_release.acquire().await.unwrap().forget();
        }
        parent_item(&script, step, &body)
    } else {
        if step == 2 && script.hold.swap(false, Ordering::SeqCst) {
            script.held.add_permits(1);
            script.release.acquire().await.unwrap().forget();
        }
        if script.resume_probe.load(Ordering::SeqCst) && step == 3 {
            call(
                "tier-next",
                "run_command",
                &json!({"command":"printf next","state_effect":"remote_observation","summary":"Check evidence"}),
            )
        } else {
            child_item(
                &body,
                step - usize::from(script.resume_probe.load(Ordering::SeqCst) && step > 3),
                script.unattended,
                script.tier.load(Ordering::SeqCst),
            )
        }
    };
    ([("content-type", "text/event-stream")], wire_items(&[item]))
}

fn parent_item(script: &Script, step: usize, body: &Value) -> Value {
    if script.unattended && !script.child {
        return if script.file_actions.load(Ordering::SeqCst) {
            file_plan(body, step)
        } else {
            action(step, false)
        };
    }
    if step == 0 && !script.delegated.swap(true, Ordering::SeqCst) {
        return call(
            "start-work",
            "delegate_to_steward",
            &json!({"request":"Prepare the evidence document.","checks":["Evidence prepared"],"safe_title":"Evidence document"}),
        );
    }
    let relation = std::mem::take(&mut *script.relation.lock().unwrap());
    if step == 0 && !relation.is_empty() {
        return call(
            "direction",
            "steer_steward",
            &json!({"relation_id":relation,"instruction":"Check the evidence again."}),
        );
    }
    message("Evidence ready.")
}

fn child_item(body: &Value, step: usize, unattended: bool, tier: bool) -> Value {
    if tier && step == 2 {
        return call(
            "tier-command",
            "run_command",
            &json!({"command":"printf reviewed","state_effect":"mutation","summary":"Check evidence"}),
        );
    }
    let step = if tier && step > 2 { step - 1 } else { step };
    match step {
        0 => call(
            "plan",
            "replace_work_plan",
            &json!({"objective":"Prepare evidence","execution_mode":"direct","actions":[{"action_key":"prepare","description":"Prepare evidence"}],"checks":["Evidence prepared"]}),
        ),
        1 => call(
            "review",
            "record_work_review",
            &json!({"subject":"plan","verdict":"accept","summary":"Ready"}),
        ),
        2..=4 if unattended => action(step - 2, false),
        2 => call(
            "deliver",
            "deliver_files",
            &json!({"files":[{"path":"report.md","title":"Evidence"}]}),
        ),
        3 if !unattended => call(
            "dispose",
            "record_work_disposition",
            &json!({"work_id":work_id(body),"disposition":if tier {"blocked"} else {"completed"},"summary":"Evidence prepared","next_condition":tier.then_some("Further direction"),"action_updates":[{"action_key":"prepare","status":"done"}],"remaining_actions":[],"followups":[]}),
        ),
        5 if unattended => call(
            "dispose",
            "record_work_disposition",
            &json!({"work_id":work_id(body),"disposition":"completed","summary":"Approval steps skipped","action_updates":[{"action_key":"prepare","status":"done"}],"remaining_actions":[],"followups":[]}),
        ),
        _ => message("Evidence prepared."),
    }
}

fn action(step: usize, files: bool) -> Value {
    if step > 2 {
        return message("Skipped approval steps and continued.");
    }
    if files {
        return call(
            &format!("action-{step}"),
            "write_file",
            &json!({"path":"notice.txt", "content":if step < 2 {"first"} else {"second"}}),
        );
    }
    call(
        &format!("action-{step}"),
        "run_command",
        &json!({"command":if step < 2 {"printf first"} else {"printf second"},"state_effect":"remote_observation","summary":"Check evidence"}),
    )
}

pub(crate) fn outputs(body: &Value) -> Vec<Value> {
    body["input"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|i| i["type"] == "function_call_output")
        .filter_map(|i| serde_json::from_str::<Value>(i["output"].as_str()?).ok())
        .map(|v| v.get("output").cloned().unwrap_or(v))
        .collect()
}

fn file_plan(body: &Value, step: usize) -> Value {
    match step {
        0 => call(
            "file-work",
            "start_work",
            &json!({"objective":"Prepare evidence"}),
        ),
        1 => call(
            "file-plan",
            "replace_work_plan",
            &json!({"objective":"Prepare evidence","execution_mode":"direct","actions":[{"action_key":"edit","description":"Write evidence"}],"checks":["Evidence prepared"]}),
        ),
        2 => call(
            "file-review",
            "record_work_review",
            &json!({"subject":"plan","verdict":"accept","summary":"Ready"}),
        ),
        3..=5 => action(step - 3, true),
        6 => call(
            "file-dispose",
            "record_work_disposition",
            &json!({"work_id":work_id(body),"disposition":"blocked","summary":"Permission steps skipped","next_condition":"Owner input","action_updates":[{"action_key":"edit","status":"blocked"}],"remaining_actions":[],"followups":[]}),
        ),
        _ => message("Skipped approval steps and continued."),
    }
}
