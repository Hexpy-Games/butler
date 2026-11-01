mod compaction;
pub(super) mod delegated;
use super::*;
use axum::{Json, Router, extract::State, response::IntoResponse, routing::post};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tokio::sync::Semaphore;

pub(crate) struct Script {
    pub(crate) compaction: AtomicBool,
    compaction_round: AtomicUsize,
    pub(crate) requests: Mutex<Vec<Value>>,
    pub epics: Mutex<Vec<String>>,
    pub path: Mutex<String>,
    pub codes: Mutex<Vec<String>>,
    pub context_seen: AtomicBool,
    pub(crate) step_seen: AtomicBool,
    pub(crate) quick: AtomicBool,
    /// Epics whose Turn just replies, whatever else this model is doing.
    pub(crate) quick_epics: Mutex<Vec<String>>,
    /// Epics this model works on directly while it delegates the others.
    pub(crate) direct_epics: Mutex<Vec<String>>,
    pub(crate) plan_review_only: AtomicBool,
    /// Closes as completed right after a result review that asked for changes.
    pub(crate) reject_result: AtomicBool,
    /// Skips every action and closes as completed without using a tool.
    pub(crate) skip_all: AtomicBool,
    /// Does the work in prose: its action is done, but no tool result exists.
    pub(crate) prose_only: AtomicBool,
    /// Records the Work blocked to ask; the reply closes that same Work without a new plan.
    pub(crate) ask_blocked: AtomicBool,
    pub(super) hold_steward: AtomicBool,
    pub(super) steward_held: Semaphore,
    pub(super) steward_release: Semaphore,
    pub(crate) delegate: AtomicBool,
    pub(super) steer_relation: Mutex<String>,
    pub(super) direction_blocked: AtomicBool,
    /// A direction's turn delegates to a Worker instead of working directly.
    pub(super) direction_worker: AtomicBool,
    pub(crate) hold_report: AtomicBool,
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
    pub(crate) async fn wait_reporting(&self) {
        tokio::time::timeout(Duration::from_secs(30), self.reporting.acquire())
            .await
            .expect("reporting round reached")
            .unwrap()
            .forget();
    }
    pub(crate) fn finish_report(&self) {
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
    /// The next Worker to start holds at its first model call again.
    pub(super) fn hold_workers_again(&self) {
        self.released.store(false, Ordering::SeqCst);
    }
}
pub(super) async fn start(
    rejects: bool,
    revise: bool,
) -> Result<(String, Arc<Script>, tokio::task::JoinHandle<()>), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/codex", listener.local_addr()?);
    let script = Arc::new(Script {
        compaction: AtomicBool::new(false),
        compaction_round: AtomicUsize::new(0),
        requests: Mutex::new(Vec::new()),
        epics: Mutex::new(Vec::new()),
        path: Mutex::new(String::new()),
        codes: Mutex::new(Vec::new()),
        context_seen: AtomicBool::new(false),
        step_seen: AtomicBool::new(false),
        quick: AtomicBool::new(false),
        quick_epics: Mutex::new(Vec::new()),
        direct_epics: Mutex::new(Vec::new()),
        plan_review_only: AtomicBool::new(false),
        reject_result: AtomicBool::new(false),
        skip_all: AtomicBool::new(false),
        prose_only: AtomicBool::new(false),
        ask_blocked: AtomicBool::new(false),
        hold_steward: AtomicBool::new(false),
        steward_held: Semaphore::new(0),
        steward_release: Semaphore::new(0),
        delegate: AtomicBool::new(false),
        steer_relation: Mutex::new(String::new()),
        direction_blocked: AtomicBool::new(false),
        direction_worker: AtomicBool::new(false),
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
    if script.compaction.load(Ordering::SeqCst)
        && body.to_string().contains("Summarize the previous summary")
    {
        let item = json!({"type":"message","id":"summary","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Evidence read; continue the current Work.","annotations":[]}]});
        return (
            [("content-type", "text/event-stream")],
            crate::token_cache::wire(&item),
        );
    }
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
    let key = butler_e2e::e2e::matching::key(
        "/codex/responses",
        &body,
        &butler_e2e::e2e::sanitize::Placeholders::default(),
    );
    let names = |list: &Mutex<Vec<String>>| {
        list.lock()
            .unwrap()
            .iter()
            .any(|epic| key.user_request.contains(epic.as_str()))
    };
    let quick_epic = names(&script.quick_epics);
    let delegated = script.delegate.load(Ordering::SeqCst) && !names(&script.direct_epics);
    let mut calls = if key.user_request == "Queue this epic" || key.user_request == "Run this plan"
    {
        script
            .queue_request
            .lock()
            .unwrap()
            .clone()
            .map(|args| vec![("canon_queue", args)])
            .unwrap_or_default()
    } else if script.quick.load(Ordering::SeqCst)
        || quick_epic
        || key.user_request == "What does this mean?"
    {
        Vec::new()
    } else if delegated {
        delegated::sequence(&script, &body, &outputs)
    } else {
        sequence(&script, &outputs, &key.user_request)
    };
    let n = if script.compaction.load(Ordering::SeqCst) {
        script.compaction_round.fetch_add(1, Ordering::SeqCst)
    } else {
        n
    };
    let (name, args) = if script.compaction.load(Ordering::SeqCst) {
        compaction::call(&script, n).await
    } else if n < calls.len() {
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
/// What a model did live: it asks by blocking its Work, then finishes on the reply.
fn ask_blocked(request: &str, selected: &str, outputs: &[Value]) -> Vec<(&'static str, Value)> {
    let work = outputs
        .iter()
        .rev()
        .find_map(|v| {
            v.pointer("/output/work/work_id")
                .or_else(|| v.pointer("/work/work_id"))
        })
        .cloned()
        .unwrap_or(Value::Null);
    if request.starts_with("canon:epic/") {
        let waiting =
            json!([{"action_key":"ask","status":"blocked","note":"Waiting for the answer"}]);
        return vec![
            (
                "replace_work_plan",
                json!({"objective":"Answer the question","execution_mode":"direct","start_new":true,"governing_refs":[format!("canon:epic/{selected}")],"actions":[{"action_key":"ask","description":"Ask, then answer"}],"checks":["The answer is written"]}),
            ),
            (
                "record_work_review",
                json!({"subject":"plan","verdict":"accept","summary":"Asks first","action_updates":[{"action_key":"ask","status":"active"}]}),
            ),
            (
                "record_work_disposition",
                json!({"work_id":work,"disposition":"blocked","summary":"Needs the answer","action_updates":waiting,"remaining_actions":["Write the answer"],"next_condition":"The answer arrives","followups":[]}),
            ),
        ];
    }
    let done = json!([{"action_key":"ask","status":"done","note":"Answered"}]);
    vec![
        (
            "canon_read",
            json!({"bind":true,"id":selected,"view":"epic"}),
        ),
        (
            "record_work_review",
            json!({"subject":"result","verdict":"accept","summary":"Answered","action_updates":done}),
        ),
        (
            "record_work_review",
            json!({"subject":"completion","verdict":"accept","summary":"Finished"}),
        ),
        (
            "record_work_disposition",
            json!({"work_id":work,"disposition":"completed","summary":"Answered","action_updates":done,"remaining_actions":[],"followups":[]}),
        ),
    ]
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
    if script.ask_blocked.load(Ordering::SeqCst) {
        return ask_blocked(request, selected, outputs);
    }
    let a = format!("canon:epic/{selected}");
    let b = format!("canon:epic/{}", epics[1]);
    let mut calls = Vec::new();
    // Another Work is open in this chat, so answering about this epic starts its own.
    let start_new =
        request.starts_with("canon:epic/") || !script.direct_epics.lock().unwrap().is_empty();
    let plan = |refs: Value| json!({"objective":"Verify the release evidence","execution_mode":"direct","start_new":start_new,"governing_refs":refs,"actions":[{"action_key":"verify","description":"Verify release evidence"}],"checks":["Evidence was read and checked"]});
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
    let skip_all = script.skip_all.load(Ordering::SeqCst);
    let prose_only = script.prose_only.load(Ordering::SeqCst);
    if !skip_all && !prose_only {
        calls.push((
            "read_file",
            json!({"requests":[{"path":*script.path.lock().unwrap()}]}),
        ));
    }
    let done = if skip_all {
        json!([{"action_key":"verify","status":"skipped","note":"Nothing to verify"}])
    } else {
        json!([{"action_key":"verify","status":"done"}])
    };
    if !skip_all {
        calls.push(("record_work_checkpoint",json!({"action_updates":done,"public_summary":"Evidence checked","next_step":"Review evidence"})));
    }
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
    if script.reject_result.load(Ordering::SeqCst) {
        calls.push((
            "record_work_review",
            json!({"subject":"result","verdict":"revise","summary":"Evidence is wrong","corrections":["Verify again"],"correction_scope":"execution"}),
        ));
    } else if !skip_all && !prose_only && !script.plan_review_only.load(Ordering::SeqCst) {
        calls.push((
            "record_work_review",
            json!({"subject":"result","verdict":"accept","summary":"Evidence verified"}),
        ));
        calls.push((
            "record_work_review",
            json!({"subject":"completion","verdict":"accept","summary":"Checks complete"}),
        ));
    }
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
