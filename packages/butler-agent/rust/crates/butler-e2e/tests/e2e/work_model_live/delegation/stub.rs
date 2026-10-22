//! Scripted feature work, parent controls, delivery and criterion correction.
mod worker;
use super::super::super::work_model_script as native;
use axum::{Json, Router, extract::State, response::IntoResponse, routing::post};
use butler_e2e::e2e::{HarnessError, matching, sanitize::Placeholders};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::Notify;

pub(super) const FEATURE: &str = "Build and verify the delegated marker feature.";
pub(super) const STEER: &str = "Correct the delegated marker before submitting.";
pub(super) const PAUSE: &str = "Pause the delegated work.";
pub(super) const RESUME: &str = "Resume the delegated work.";
pub(super) const LEGACY_STOP: &str = "Cancel the delegated work through the legacy control.";
pub(super) const LEGACY_RESUME: &str = "Continue the stopped delegated work.";
pub(super) const STALE: &str = "Send a control against an old epoch.";
pub(super) const MISSING: &str = "Send a control after execution state was removed.";
pub(super) const INVALID: &str = "Send a control with invalid mode.";
pub(super) const STOP: &str = "Stop the delegated feature work.";
pub(super) const QUEUED: &str = "Acknowledge this after the delegated result.";
pub(super) const SECOND: &str = "Start the next verification Task after the completed feature.";
pub(super) const EDIT: &str =
    "Apply the approved criterion correction and preserve the completed work.";
pub(super) const LATER: &str = "Review and complete the previously delivered result.";
pub(super) const DEFERRED: &str = "The child result has arrived for later review.";
pub(super) const RESULT: &str = "The delegated marker feature is verified.";
pub(super) const QUEUED_REPLY: &str = "The later request is acknowledged.";

pub(super) struct Script {
    pub requests: Mutex<Vec<Value>>,
    pub target: Mutex<String>,
    pub hold: Mutex<String>,
    pub relation: Mutex<String>,
    pub child_held: Notify,
    pub release_child: Notify,
    pub report_held: Notify,
    pub release_report: Notify,
    pub hold_report: AtomicBool,
    pub defer_review: AtomicBool,
    pub use_worker: AtomicBool,
}
impl Default for Script {
    fn default() -> Self {
        Self {
            requests: Mutex::default(),
            target: Mutex::default(),
            hold: Mutex::default(),
            relation: Mutex::default(),
            child_held: Notify::new(),
            release_child: Notify::new(),
            report_held: Notify::new(),
            release_report: Notify::new(),
            hold_report: AtomicBool::new(true),
            defer_review: AtomicBool::new(false),
            use_worker: AtomicBool::new(false),
        }
    }
}
pub(super) async fn start()
-> Result<(String, Arc<Script>, tokio::task::JoinHandle<()>), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}", listener.local_addr()?);
    let script = Arc::new(Script::default());
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
) -> axum::response::Response {
    let key = matching::key("/codex/responses", &body, &Placeholders::default());
    let step = native::outputs(&body).len();
    script.requests.lock().unwrap().push(body.clone());
    let request = key.user_request.as_str();
    if request.starts_with("role: steward") && step == 2 {
        script.child_held.notify_one();
        script.release_child.notified().await;
    }
    if request.contains("Delegated result")
        && step == 3
        && script.hold_report.load(Ordering::SeqCst)
    {
        script.report_held.notify_one();
        script.release_report.notified().await;
    }
    let item = if request.starts_with("role: worker") {
        worker::execute(step, &body)
    } else if script.use_worker.load(Ordering::SeqCst) && request.starts_with("role: steward") {
        worker::steward(step, &body)
    } else if script.use_worker.load(Ordering::SeqCst)
        && request.contains("Delegated result")
        && body["instructions"]
            .as_str()
            .is_some_and(|text| text.starts_with("You run one delegated Work"))
    {
        worker::result(step, &body)
    } else if request.starts_with("role: steward")
        || request.contains("Resume the assigned Task from its retained checkpoint.")
        || request.contains("Continue from the retained checkpoint.")
    {
        child(step, &body)
    } else if request == FEATURE {
        parent(step, &body)
    } else if [STEER, STOP, PAUSE, RESUME, INVALID, STALE, MISSING].contains(&request) {
        control(step, request, &script)
    } else if request == LEGACY_STOP && step == 0 {
        call(step, "cancel_steward", &json!({}))
    } else if request == LEGACY_RESUME && step == 0 {
        call(
            step,
            "steer_steward",
            &json!({"relation_id":script.relation.lock().unwrap().clone(),"instruction":"Continue from the retained checkpoint."}),
        )
    } else if request == SECOND {
        second(step, &body)
    } else if request == EDIT {
        edit(step, &body)
    } else if request == LATER {
        result(step, &body, request)
    } else if request == QUEUED {
        message(QUEUED_REPLY)
    } else if request.contains("Delegated result") && script.defer_review.load(Ordering::SeqCst) {
        message(DEFERRED)
    } else if request.contains("Delegated result") {
        result(step, &body, request)
    } else {
        message("{}")
    };
    (
        [("content-type", "text/event-stream")],
        super::super::super::token_cache::wire(&item),
    )
        .into_response()
}

fn call(step: usize, name: &str, args: &Value) -> Value {
    super::super::super::access_tiers::stub::call(&format!("native-{step}"), name, args)
}
fn message(text: &str) -> Value {
    json!({"type":"message","id":"native-answer","role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]})
}
fn read_task(step: usize, body: &Value) -> Value {
    call(
        step,
        "work_read",
        &json!({"view":"task","task_id":native::task_id(body)}),
    )
}

fn parent(step: usize, body: &Value) -> Value {
    match step {
        0 => call(
            step,
            "work_apply",
            &native::bootstrap(FEATURE, &["Marker built", "Output checked"]),
        ),
        1 => read_task(step, body),
        2 => call(
            step,
            "delegate_to_steward",
            &json!({"request":"Build the requested marker and retain evidence."}),
        ),
        _ => message("The feature work is assigned."),
    }
}
fn child(step: usize, body: &Value) -> Value {
    match step {
        0 => call(step, "work_read", &json!({"view":"tasks"})),
        1 => read_task(step, body),
        2 => call(
            step,
            "write_file",
            &json!({"path":"feature-marker.txt","content":"original marker"}),
        ),
        3 => call(
            step,
            "write_file",
            &json!({"path":"feature-marker.txt","content":"corrected marker"}),
        ),
        4 => call(
            step,
            "work_apply",
            &native::submit(body, "feature-marker.txt"),
        ),
        _ => message("The corrected marker was built and checked."),
    }
}
fn control(step: usize, request: &str, script: &Script) -> Value {
    if step > 0 {
        return message("Control accepted.");
    }
    let stop = request == STOP;
    call(
        step,
        "session_control",
        &json!({"target_session_id":script.target.lock().unwrap().clone(),"mode":if request==INVALID {"invalid"}else{"steer"},
        "instruction":match request {STOP=>json!({"control":"stop"}),PAUSE=>json!({"control":"pause"}),RESUME=>json!({"control":"resume","hold_id":script.hold.lock().unwrap().clone()}),_=>json!({"text":"Use the corrected marker before submitting."})},
        "expected_control_epoch":if request==STALE {99}else{i32::from(stop||request==RESUME)},"idempotency_key":request}),
    )
}
fn result(step: usize, body: &Value, request: &str) -> Value {
    if request.contains("status: cancelled") {
        return message("The delegated work was stopped; its Task remains resumable.");
    }
    match step {
        0 => call(step, "work_read", &json!({"view":"tasks"})),
        1 => read_task(step, body),
        2 => native::complete(body)
            .map(|args| call(step, "work_apply", &args))
            .unwrap_or_else(|| message("The result needs input.")),
        _ => message(RESULT),
    }
}
fn second(step: usize, body: &Value) -> Value {
    match step {
        0 => call(step, "work_read", &json!({"view":"tasks"})),
        1 => read_task(step, body),
        2 => {
            let mut args = native::extend(body, SECOND);
            let placement = args["operations"][0].as_object_mut().unwrap();
            placement.remove("step");
            placement.insert("after_task_id".into(), native::task_id(body));
            call(step, "work_apply", &args)
        }
        _ => message("The next verification Task is running."),
    }
}
fn edit(step: usize, body: &Value) -> Value {
    match step {
        0 => call(step, "work_read", &json!({"view":"spec"})),
        1 => call(step, "work_read", &json!({"view":"tasks"})),
        2 => read_task(step, body),
        3 => call(step, "work_apply", &criterion_delta(body)),
        4 => call(
            step,
            "write_file",
            &json!({"path":"stale-effect.txt","content":"must be fenced"}),
        ),
        _ => message(
            "The approved criterion is active; corrective Tasks retain the completed history.",
        ),
    }
}
fn criterion_delta(body: &Value) -> Value {
    let outputs = native::outputs(body);
    let publication = outputs
        .iter()
        .find_map(|output| output.pointer("/view/published"))
        .unwrap();
    let node = outputs
        .iter()
        .find_map(|output| output.pointer("/view/node"))
        .unwrap();
    let layout = outputs
        .iter()
        .find_map(|output| output.pointer("/view/chains"))
        .unwrap();
    let next = node["revision"].as_i64().unwrap() + 1;
    let root = node["node_id"].as_str().unwrap();
    let tasks: Vec<_> = layout
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|chain| chain["steps"].as_array().unwrap())
        .flat_map(|step| step["tasks"].as_array().unwrap())
        .collect();
    let impacts: serde_json::Map<String, Value> = tasks
        .iter()
        .map(|task| {
            (
                task["id"].as_str().unwrap().to_owned(),
                json!({"action":"reverify","reason":"Verify the corrected criterion"}),
            )
        })
        .collect();
    let mut expected = serde_json::Map::from_iter([(root.to_owned(), node["revision"].clone())]);
    expected.extend(tasks.iter().map(|task| {
        (
            task["id"].as_str().unwrap().to_owned(),
            task["revision"].clone(),
        )
    }));
    json!({"reason":"Apply the approved criterion correction and fence stale execution","spec_ref":{"node_id":root,"revision":publication["revision"],"body_hash":publication["body_hash"]},
    "expected_task_graph_revision":native::graph(body),"expected_revisions":expected,"operations":[
        {"op":"spec.propose","key":"changed","node_id":root,"base_revision":node["active_revision"],"node":{"title":FEATURE,"goal":FEATURE,"criteria":["Corrected marker verified"],"constraints":[]}},
        {"op":"spec.activate","expected_tree_version":1,"published_refs":[{"node_id":"@changed","revision":next,"body_hash":"@changed"}],"impact_map":impacts}
    ]})
}
