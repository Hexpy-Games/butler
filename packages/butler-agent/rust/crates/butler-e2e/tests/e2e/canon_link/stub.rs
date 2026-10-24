mod delegated;
use super::*;
use axum::{Json, Router, extract::State, response::IntoResponse, routing::post};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::Semaphore;

pub(super) struct Script {
    pub epics: Mutex<Vec<String>>,
    pub path: Mutex<String>,
    pub codes: Mutex<Vec<String>>,
    pub context_seen: AtomicBool,
    pub(super) delegate: AtomicBool,
    pub(super) hold_report: AtomicBool,
    reporting: Semaphore,
    report_release: Semaphore,
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

    pub(super) async fn wait_held(&self) {
        tokio::time::timeout(Duration::from_secs(30), self.held.acquire())
            .await
            .expect("model reached checkpoint")
            .unwrap()
            .forget();
    }
    pub(super) fn release(&self) {
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
        epics: Mutex::new(Vec::new()),
        path: Mutex::new(String::new()),
        codes: Mutex::new(Vec::new()),
        context_seen: AtomicBool::new(false),
        delegate: AtomicBool::new(false),
        hold_report: AtomicBool::new(false),
        reporting: Semaphore::new(0),
        report_release: Semaphore::new(0),
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
    if context.contains("## Canon epics in this conversation")
        && context.contains("untrusted_content")
        && context.contains("Release checks")
    {
        script.context_seen.store(true, Ordering::SeqCst);
    }
    let n = outputs.len();
    let delegated = script.delegate.load(Ordering::SeqCst);
    let mut calls = if delegated {
        delegated::sequence(&script, &body, &outputs)
    } else {
        sequence(&script, &outputs)
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
    let item = if name.is_empty() {
        json!({"type":"message","id":"canon-report","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Release checks: verified the evidence and completed the report.","annotations":[]}]})
    } else {
        json!({"type":"function_call","id":format!("canon-flow-{n}"),"call_id":format!("canon-flow-{n}"),"name":name,"arguments":args.to_string(),"status":"completed"})
    };
    (
        [("content-type", "text/event-stream")],
        crate::token_cache::wire(&item),
    )
}
fn sequence(script: &Script, outputs: &[Value]) -> Vec<(&'static str, Value)> {
    let epics = script.epics.lock().unwrap();
    let a = format!("canon:epic/{}", epics[0]);
    let b = format!("canon:epic/{}", epics[1]);
    let mut calls = Vec::new();
    let plan = |refs: Value| json!({"objective":"Verify the release evidence","execution_mode":"direct","governing_refs":refs,"actions":[{"action_key":"verify","description":"Verify release evidence"}],"checks":["Evidence was read and checked"]});
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
    calls.push(("read_file", json!({"path":*script.path.lock().unwrap()})));
    let done = json!([{"action_key":"verify","status":"done"}]);
    calls.push(("record_work_checkpoint",json!({"action_updates":done,"public_summary":"Evidence checked","next_step":"Review evidence"})));
    if script.revise {
        calls.push(("record_work_review",json!({"subject":"result","verdict":"revise","summary":"Check again","corrections":["Verify once more"],"correction_scope":"execution","action_updates":[{"action_key":"verify","status":"active"}]})));
        calls.push(("read_file", json!({"path":*script.path.lock().unwrap()})));
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
    calls.push(("record_work_disposition",json!({"work_id":work,"disposition":"completed","summary":"Evidence verified","action_updates":done,"remaining_actions":[],"followups":[]})));
    calls
}
