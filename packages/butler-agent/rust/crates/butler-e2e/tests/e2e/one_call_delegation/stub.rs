//! Deterministic model for one-call handoff and the Steward's revision gate.
use super::*;
use crate::steward_presentation::stub::{call, child_lane, message, wire_items, work_id};
use axum::{Json, Router, extract::State, response::IntoResponse, routing::post};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::Semaphore;

pub(super) const REQUEST: &str = "Delegate verifying and updating the workspace evidence.";
pub(super) const FOLLOWUP: &str = "Delegate verifying the workspace evidence again.";
pub(super) const ANSWER: &str = "Workspace evidence verified.";

pub(super) struct Script {
    pub requests: Mutex<Vec<Value>>,
    pub relation: Mutex<String>,
    pub workspace: Mutex<std::path::PathBuf>,
    pub queue_release: Mutex<Option<std::path::PathBuf>>,
    pub held: Semaphore,
    pub release: Semaphore,
    pub hold: AtomicBool,
    pub legacy_closeout: AtomicBool,
    pub legacy_plan: AtomicBool,
    pub parent_work: Mutex<String>,
    pub epic: Mutex<Option<String>>,
    pub blocked: AtomicBool,
}

pub(super) async fn start()
-> Result<(String, Arc<Script>, tokio::task::JoinHandle<()>), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}", listener.local_addr()?);
    let script = Arc::new(Script {
        requests: Mutex::default(),
        relation: Mutex::default(),
        workspace: Mutex::default(),
        queue_release: Mutex::default(),
        held: Semaphore::new(0),
        release: Semaphore::new(0),
        hold: AtomicBool::new(true),
        legacy_closeout: AtomicBool::new(false),
        legacy_plan: AtomicBool::new(false),
        parent_work: Mutex::default(),
        epic: Mutex::default(),
        blocked: AtomicBool::new(false),
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
    let request =
        butler_e2e::e2e::matching::key("/v1/responses", &body, &Default::default()).user_request;
    let child = child_lane(&body);
    let outputs = outputs(&body);
    let step = outputs.len();
    script.requests.lock().unwrap().push(body.clone());
    if child && step == 3 && script.hold.swap(false, Ordering::SeqCst) {
        script.held.add_permits(1);
        script.release.acquire().await.unwrap().forget();
    }
    let item = if child {
        child_item(
            step,
            &body,
            &script.workspace.lock().unwrap(),
            script.blocked.load(Ordering::SeqCst),
        )
    } else if request == REQUEST && script.legacy_plan.load(Ordering::SeqCst) {
        legacy_parent_item(step)
    } else if (request == REQUEST || request == FOLLOWUP) && step == 0 {
        if let Some(path) = script.queue_release.lock().unwrap().take() {
            std::fs::remove_file(path).unwrap();
        }
        let mut args =
            json!({"request":request,"checks":["Evidence verified"],"safe_title":"Evidence check"});
        if let Some(epic) = script.epic.lock().unwrap().clone() {
            args["epic_ref"] = epic.into();
        }
        if request == FOLLOWUP {
            args["previous_relation_id"] = script.relation.lock().unwrap().clone().into();
        }
        call("handoff", "delegate_to_steward", &args)
    } else if request.contains("Delegated result")
        && step == 0
        && script.legacy_closeout.load(Ordering::SeqCst)
    {
        call(
            "legacy-closeout",
            "record_work_disposition",
            &json!({
                "work_id":*script.parent_work.lock().unwrap(), "disposition":"completed", "summary":ANSWER,
                "remaining_actions":[], "followups":[]
            }),
        )
    } else if request.contains("Delegated result") {
        message(ANSWER)
    } else if request == REQUEST || request == FOLLOWUP {
        message("Evidence check started.")
    } else {
        message("{}")
    };
    ([("content-type", "text/event-stream")], wire_items(&[item]))
}

fn child_item(step: usize, body: &Value, workspace: &std::path::Path, blocked: bool) -> Value {
    let path = |name: &str| workspace.join(name).to_string_lossy().into_owned();
    let plan = || {
        json!({"objective":"Verify workspace evidence","execution_mode":"direct",
        "actions":[{"action_key":"verify","description":"Verify workspace evidence"}],"checks":["Evidence verified"]})
    };
    let review = || json!({"subject":"plan","verdict":"accept","summary":"Ready"});
    match step {
        0 => call(
            "early-write",
            "write_file",
            &json!({"path":path("early.txt"),"content":"forbidden"}),
        ),
        1 => call(
            "early-command",
            "run_command",
            &json!({"command":format!(r#"printf forbidden > "{}""#, path("command.txt")),"state_effect":"mutation","summary":"Write evidence"}),
        ),
        2 => call(
            "inspect",
            "read_file",
            &json!({"requests":[{"path":path("source.txt")}]}),
        ),
        3 => call("plan", "replace_work_plan", &plan()),
        4 => call("accept", "record_work_review", &review()),
        5 => call(
            "write",
            "write_file",
            &json!({"path":path("evidence.txt"),"content":"first"}),
        ),
        6 => call("revise", "replace_work_plan", &plan()),
        7 => call(
            "unreviewed-write",
            "write_file",
            &json!({"path":path("revision.txt"),"content":"forbidden"}),
        ),
        8 => call("accept-revision", "record_work_review", &review()),
        9 => call(
            "final-write",
            "write_file",
            &json!({"path":path("evidence.txt"),"content":"verified"}),
        ),
        10 => call(
            "settle",
            "record_work_disposition",
            &json!({"work_id":work_id(body),
            "disposition":if blocked {"blocked"} else {"completed"},"summary":ANSWER,"next_condition":if blocked {Some("Owner input is needed")} else {None},"action_updates":[{"action_key":"verify","status":if blocked {"blocked"} else {"done"}}],
            "remaining_actions":[],"followups":[]}),
        ),
        _ => message(ANSWER),
    }
}

pub(super) fn outputs(body: &Value) -> Vec<Value> {
    body["input"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| item["type"] == "function_call_output")
        .filter_map(|item| serde_json::from_str::<Value>(item["output"].as_str()?).ok())
        .map(|value| value.get("output").cloned().unwrap_or(value))
        .collect()
}

fn legacy_parent_item(step: usize) -> Value {
    match step {
        0 => call("start", "start_work", &json!({"objective":REQUEST})),
        1 => call(
            "parent-plan",
            "replace_work_plan",
            &json!({
                "objective":REQUEST,"execution_mode":"steward",
                "actions":[{"action_key":"verify","description":"Verify workspace evidence"}],
                "checks":["Legacy acceptance"]
            }),
        ),
        2 => call(
            "parent-review",
            "record_work_review",
            &json!({
                "subject":"plan","verdict":"accept","summary":"Ready"
            }),
        ),
        3 => call(
            "handoff",
            "delegate_to_steward",
            &json!({"request":REQUEST}),
        ),
        _ => message("Evidence check started."),
    }
}
