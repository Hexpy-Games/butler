//! Scripted feature work, parent controls, delivery and criterion correction.
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
pub(super) const STOP: &str = "Stop the delegated feature work.";
pub(super) const QUEUED: &str = "Acknowledge this after the delegated result.";
pub(super) const SECOND: &str = "Start the next verification Task after the completed feature.";
pub(super) const EDIT: &str =
    "Apply the approved criterion correction and preserve the completed work.";
pub(super) const RESULT: &str = "The delegated marker feature is verified.";
pub(super) const QUEUED_REPLY: &str = "The later request is acknowledged.";

pub(super) struct Script {
    pub requests: Mutex<Vec<Value>>,
    pub target: Mutex<String>,
    pub child_held: Notify,
    pub release_child: Notify,
    pub report_held: Notify,
    pub release_report: Notify,
    pub hold_report: AtomicBool,
}
impl Default for Script {
    fn default() -> Self {
        Self {
            requests: Mutex::default(),
            target: Mutex::default(),
            child_held: Notify::new(),
            release_child: Notify::new(),
            report_held: Notify::new(),
            release_report: Notify::new(),
            hold_report: AtomicBool::new(true),
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
    let item = if request.starts_with("role: steward") {
        child(step, &body)
    } else if request == FEATURE {
        parent(step, &body)
    } else if request == STEER || request == STOP {
        control(step, request, &script)
    } else if request == SECOND {
        second(step, &body)
    } else if request == EDIT {
        edit(step, &body)
    } else if request == QUEUED {
        message(QUEUED_REPLY)
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

fn call(step: usize, name: &str, args: Value) -> Value {
    super::super::super::access_tiers::stub::call(&format!("native-{step}"), name, &args)
}
fn message(text: &str) -> Value {
    json!({"type":"message","id":"native-answer","role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]})
}
fn read_task(step: usize, body: &Value) -> Value {
    call(
        step,
        "work_read",
        json!({"view":"task","task_id":native::task_id(body)}),
    )
}

fn parent(step: usize, body: &Value) -> Value {
    match step {
        0 => call(
            step,
            "work_apply",
            native::bootstrap(FEATURE, &["Marker built", "Output checked"]),
        ),
        1 => read_task(step, body),
        2 => call(
            step,
            "delegate_to_steward",
            json!({"request":"Build the requested marker and retain evidence."}),
        ),
        _ => message("The feature work is assigned."),
    }
}
fn child(step: usize, body: &Value) -> Value {
    match step {
        0 => call(step, "work_read", json!({"view":"tasks"})),
        1 => read_task(step, body),
        2 => call(
            step,
            "write_file",
            json!({"path":"feature-marker.txt","content":"original marker"}),
        ),
        3 => call(
            step,
            "write_file",
            json!({"path":"feature-marker.txt","content":"corrected marker"}),
        ),
        4 => call(
            step,
            "work_apply",
            native::submit(body, "feature-marker.txt"),
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
        json!({"target_session_id":script.target.lock().unwrap().clone(),"mode":"steer",
        "instruction":if stop {json!({"control":"stop"})}else{json!({"text":"Use the corrected marker before submitting."})},
        "expected_control_epoch":if stop {1}else{0},"idempotency_key":if stop {"stop-feature"}else{"steer-feature"}}),
    )
}
fn result(step: usize, body: &Value, request: &str) -> Value {
    if request.contains("status: cancelled") {
        return message("The delegated work was stopped; its Task remains resumable.");
    }
    match step {
        0 => call(step, "work_read", json!({"view":"tasks"})),
        1 => read_task(step, body),
        2 => native::complete(body)
            .map(|args| call(step, "work_apply", args))
            .unwrap_or_else(|| message("The result needs input.")),
        _ => message(RESULT),
    }
}
fn second(step: usize, body: &Value) -> Value {
    match step {
        0 => call(step, "work_read", json!({"view":"tasks"})),
        1 => read_task(step, body),
        2 => {
            let mut args = native::extend(body, SECOND);
            let placement = args["operations"][0].as_object_mut().unwrap();
            placement.remove("step");
            placement.insert("after_task_id".into(), native::task_id(body));
            call(step, "work_apply", args)
        }
        _ => message("The next verification Task is running."),
    }
}
fn edit(step: usize, body: &Value) -> Value {
    match step {
        0 => call(step, "work_read", json!({"view":"spec"})),
        1 => call(step, "work_read", json!({"view":"tasks"})),
        2 => read_task(step, body),
        3 => call(step, "work_apply", criterion_delta(body)),
        4 => call(
            step,
            "write_file",
            json!({"path":"stale-effect.txt","content":"must be fenced"}),
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
    let criteria: Vec<_> = native::view(body)["criteria"]
        .as_array()
        .unwrap()
        .iter()
        .map(|criterion| {
            if criterion["node_id"] == root {
                json!({"node_id":root,"node_revision":next,"criterion_id":"c0"})
            } else {
                criterion.clone()
            }
        })
        .collect();
    let criteria: Vec<_> = criteria
        .into_iter()
        .fold(Vec::<Value>::new(), |mut refs, item| {
            if !refs.contains(&item) {
                refs.push(item)
            }
            refs
        });
    let impacts:Vec<_>=layout.as_array().unwrap().iter().flat_map(|chain|chain["steps"].as_array().unwrap())
        .flat_map(|step|step["tasks"].as_array().unwrap()).map(|task|json!({"task_id":task["id"],"expected_revision":task["revision"],
            "acceptance_refs":criteria,"corrective":{"title":"Verify the corrected criterion","description":"Recheck this Task's outcome against the approved correction"}})).collect();
    json!({"reason":"Apply the approved criterion correction and fence stale execution","spec_ref":{"node_id":root,"revision":publication["revision"],"body_hash":publication["body_hash"]},
    "expected_task_graph_revision":native::graph(body),"expected_revisions":{root:node["revision"]},"operations":[
        {"op":"spec.propose","key":"changed","node_id":root,"base_revision":node["active_revision"],"node":{"title":FEATURE,"goal":FEATURE,"criteria":["Corrected marker verified"],"constraints":[]}},
        {"op":"spec.activate","expected_tree_version":1,"published_refs":[{"node_id":"@changed","revision":next,"body_hash":"@changed"}],"impact_map":{"tasks":impacts}}
    ]})
}
