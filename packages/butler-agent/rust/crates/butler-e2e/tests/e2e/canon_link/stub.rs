mod delegated;
use super::*;
use axum::{Json, Router, extract::State, response::IntoResponse, routing::post};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::Semaphore;

pub(crate) struct Script {
    pub(crate) requests: Mutex<Vec<Value>>,
    pub epics: Mutex<Vec<String>>,
    pub path: Mutex<String>,
    pub codes: Mutex<Vec<String>>,
    pub context_seen: AtomicBool,
    pub(crate) step_seen: AtomicBool,
    pub(crate) quick: AtomicBool,
    pub(super) hold_steward: AtomicBool,
    pub(super) steward_held: Semaphore,
    pub(super) steward_release: Semaphore,
    pub(crate) delegate: AtomicBool,
    pub(super) hold_report: AtomicBool,
    reporting: Semaphore,
    report_release: Semaphore,
    pub(crate) blocked: Mutex<Vec<String>>,
    pub(crate) queue_request: Mutex<Option<Value>>,
    rejects: bool,
    revise: bool,
    held: Semaphore,
    release: Semaphore,
    released: AtomicBool,
}
impl Script {
    pub(super) async fn wait_reporting(&self) {
        tokio::time::timeout(Duration::from_secs(30), self.reporting.acquire())
            .await
            .expect("reporting round reached")
            .unwrap()
            .forget();
    }
    pub(super) fn finish_report(&self) {
        self.report_release.add_permits(1);
    }

    pub(crate) async fn wait_held(&self) {
        tokio::time::timeout(Duration::from_secs(30), self.held.acquire())
            .await
            .expect("model reached checkpoint")
            .unwrap()
            .forget();
    }
    pub(crate) fn release(&self) {
        self.released.store(true, Ordering::SeqCst);
        self.release.add_permits(1);
    }
}
pub(super) async fn start(
    rejects: bool,
    revise: bool,
) -> Result<(String, Arc<Script>, tokio::task::JoinHandle<()>), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/codex", listener.local_addr()?);
    let script = Arc::new(Script {
        requests: Mutex::new(Vec::new()),
        epics: Mutex::new(Vec::new()),
        path: Mutex::new(String::new()),
        codes: Mutex::new(Vec::new()),
        context_seen: AtomicBool::new(false),
        step_seen: AtomicBool::new(false),
        quick: AtomicBool::new(false),
        hold_steward: AtomicBool::new(false),
        steward_held: Semaphore::new(0),
        steward_release: Semaphore::new(0),
        delegate: AtomicBool::new(false),
        hold_report: AtomicBool::new(false),
        reporting: Semaphore::new(0),
        report_release: Semaphore::new(0),
        blocked: Mutex::new(Vec::new()),
        queue_request: Mutex::new(None),
        rejects,
        revise,
        held: Semaphore::new(0),
        release: Semaphore::new(0),
        released: AtomicBool::new(false),
    });
    let app = Router::new()
        .route("/codex/responses", post(reply))
        .with_state(script.clone());
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok((url, script, server))
}
async fn reply(State(script): State<Arc<Script>>, Json(body): Json<Value>) -> impl IntoResponse {
    script.requests.lock().unwrap().push(body.clone());
    let outputs: Vec<Value> = body["input"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|v| {
            v["type"] == "function_call_output"
                && v["call_id"]
                    .as_str()
                    .is_some_and(|s| s.starts_with("canon-flow-"))
        })
        .filter_map(|v| v["output"].as_str())
        .filter_map(|s| serde_json::from_str(s).ok())
        .collect();
    for output in &outputs {
        let output = output.get("output").unwrap_or(output);
        if let Some(code) = output["error"]["code"].as_str() {
            script.codes.lock().unwrap().push(code.to_owned());
        }
    }
    let context = body.to_string();
    if context.contains("now, starting at Conception. Start a fresh Work for this epic") {
        script.step_seen.store(true, Ordering::SeqCst);
    }
    if context.contains("## Canon epics in this conversation")
        && context.contains("untrusted_content")
        && context.contains("Release checks")
        && context.contains("Release evidence")
    {
        script.context_seen.store(true, Ordering::SeqCst);
    }
    if delegated::returning_steward(&body) && script.hold_steward.swap(false, Ordering::SeqCst) {
        script.steward_held.add_permits(1);
        script.steward_release.acquire().await.unwrap().forget();
    }
    let n = outputs.len();
    let delegated = script.delegate.load(Ordering::SeqCst);
    let key = butler_e2e::e2e::matching::key(
        "/codex/responses",
        &body,
        &butler_e2e::e2e::sanitize::Placeholders::default(),
    );
    let mut calls = if key.user_request == "Queue this epic" || key.user_request == "Run this plan"
    {
        script
            .queue_request
            .lock()
            .unwrap()
            .clone()
            .map(|args| vec![("canon_queue", args)])
            .unwrap_or_default()
    } else if script.quick.load(Ordering::SeqCst) || key.user_request == "What does this mean?" {
        Vec::new()
    } else if delegated {
        delegated::sequence(&script, &body, &outputs)
    } else {
        sequence(&script, &outputs, &key.user_request)
    };
    let (name, args) = if n < calls.len() {
        calls.remove(n)
    } else {
        ("", json!(null))
    };
    let worker = body.to_string().contains("role: worker");
    if ((!delegated && name == "record_work_checkpoint") || (delegated && worker && n == 0))
        && !script.released.load(Ordering::SeqCst)
    {
        script.held.add_permits(1);
        script.release.acquire().await.unwrap().forget();
    }
    if name.is_empty() && script.hold_report.swap(false, Ordering::SeqCst) {
        script.reporting.add_permits(1);
        script.report_release.acquire().await.unwrap().forget();
    }
    let text = if script.quick.load(Ordering::SeqCst) {
        "Which evidence should I check?"
    } else {
        "Release checks: verified the evidence and completed the report."
    };
    let item = if name.is_empty() {
        json!({"type":"message","id":"canon-report","role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]})
    } else {
        json!({"type":"function_call","id":format!("canon-flow-{n}"),"call_id":format!("canon-flow-{n}"),"name":name,"arguments":args.to_string(),"status":"completed"})
    };
    (
        [("content-type", "text/event-stream")],
        crate::token_cache::wire(&item),
    )
}
fn sequence(script: &Script, outputs: &[Value], request: &str) -> Vec<(&'static str, Value)> {
    let epics = script.epics.lock().unwrap();
    let selected = request
        .strip_prefix("canon:epic/")
        .or_else(|| {
            request
                .strip_prefix("Process canon:epic/")
                .and_then(|s| s.split_whitespace().next())
        })
        .filter(|id| epics.iter().any(|e| e == id))
        .unwrap_or(&epics[0]);
    let a = format!("canon:epic/{selected}");
    let b = format!("canon:epic/{}", epics[1]);
    let mut calls = Vec::new();
    let plan = |refs: Value| json!({"objective":"Verify the release evidence","execution_mode":"direct","start_new":request.starts_with("canon:epic/"),"governing_refs":refs,"actions":[{"action_key":"verify","description":"Verify release evidence"}],"checks":["Evidence was read and checked"]});
    if script.rejects {
        calls.push(("replace_work_plan", plan(json!([a, b]))));
        calls.push(("replace_work_plan", plan(json!(["canon:epic/unbound"]))));
    }
    calls.push(("replace_work_plan", plan(json!([a]))));
    if script.rejects {
        calls.push(("replace_work_plan", plan(json!([b]))));
        calls.push(("replace_work_plan", plan(json!([]))));
        calls.push(("replace_work_plan", plan(json!([a]))));
    }
    calls.push((
        "record_work_review",
        json!({"subject":"plan","verdict":"accept","summary":"Covers the evidence"}),
    ));
    calls.push((
        "read_file",
        json!({"requests":[{"path":*script.path.lock().unwrap()}]}),
    ));
    let done = json!([{"action_key":"verify","status":"done"}]);
    calls.push(("record_work_checkpoint",json!({"action_updates":done,"public_summary":"Evidence checked","next_step":"Review evidence"})));
    if script.revise {
        calls.push(("record_work_review",json!({"subject":"result","verdict":"revise","summary":"Check again","corrections":["Verify once more"],"correction_scope":"execution","action_updates":[{"action_key":"verify","status":"active"}]})));
        calls.push((
            "read_file",
            json!({"requests":[{"path":*script.path.lock().unwrap()}]}),
        ));
        calls.push((
            "record_work_checkpoint",
            json!({"action_updates":done,"public_summary":"Rechecked","next_step":"Review"}),
        ));
    }
    calls.push((
        "record_work_review",
        json!({"subject":"result","verdict":"accept","summary":"Evidence verified"}),
    ));
    calls.push((
        "record_work_review",
        json!({"subject":"completion","verdict":"accept","summary":"Checks complete"}),
    ));
    let work = outputs
        .iter()
        .rev()
        .find_map(|v| {
            v.pointer("/output/work/work_id")
                .or_else(|| v.pointer("/work/work_id"))
        })
        .cloned()
        .unwrap_or(Value::Null);
    let disposition = if script.blocked.lock().unwrap().iter().any(|e| e == selected) {
        "blocked"
    } else {
        "completed"
    };
    calls.push(("record_work_disposition",json!({"work_id":work,"disposition":disposition,"summary":"Evidence verified","action_updates":done,"remaining_actions":[],"followups":[]})));
    calls
}
