//! Structure-driven local responder; no matching of owner prose.
use super::*;
use axum::{Json, Router, extract::State, routing::post};
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub(super) struct Script {
    pub args: Mutex<Value>,
    pub retry: std::sync::atomic::AtomicBool,
    pub direct: std::sync::atomic::AtomicBool,
    pub outputs: Mutex<Vec<Value>>,
    pub offered: Mutex<Vec<String>>,
}
pub(super) struct Server(tokio::task::JoinHandle<()>);
impl Drop for Server {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub(super) async fn start() -> Result<(String, Arc<Script>, Server), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/codex", listener.local_addr()?);
    let script = Arc::new(Script::default());
    let router = Router::new()
        .route("/codex/responses", post(reply))
        .with_state(script.clone());
    let server = Server(tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    }));
    Ok((url, script, server))
}
async fn reply(
    State(script): State<Arc<Script>>,
    Json(body): Json<Value>,
) -> impl axum::response::IntoResponse {
    let inputs = body["input"].as_array().cloned().unwrap_or_default();
    let done = |id: &str| {
        inputs
            .iter()
            .any(|v| v["type"] == "function_call_output" && v["call_id"] == id)
    };
    let outputs: Vec<Value> = inputs
        .iter()
        .filter(|v| v["type"] == "function_call_output")
        .filter_map(|v| serde_json::from_str(v["output"].as_str()?).ok())
        .collect();
    if body["tools"]
        .as_array()
        .is_some_and(|tools| !tools.is_empty())
    {
        *script.outputs.lock().unwrap() = outputs.clone();
        *script.offered.lock().unwrap() = body["tools"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|t| t["name"].as_str().map(str::to_owned))
            .collect();
    }
    let work = outputs.iter().find_map(work_id).unwrap_or_default();
    let call = if body["tools"].as_array().is_none_or(Vec::is_empty) {
        None
    } else if !done("propose-start") {
        Some((
            "propose-start",
            "start_work",
            json!({"objective":"Create the requested board item"}),
        ))
    } else if !done("propose-plan") {
        Some((
            "propose-plan",
            "replace_work_plan",
            json!({"objective":"Create the requested board item",
            "execution_mode":"direct","actions":[{"action_key":"create","description":"Create board item"}],
            "checks":["The board contains exactly the requested item"]}),
        ))
    } else if !done("propose-review") {
        Some((
            "propose-review",
            "record_work_review",
            json!({"subject":"plan","verdict":"accept",
            "summary":"Matches the request","action_updates":[{"action_key":"create","status":"active"}]}),
        ))
    } else if !done("propose-call") {
        Some((
            "propose-call",
            if script.direct.load(std::sync::atomic::Ordering::SeqCst) {
                "canon_propose"
            } else {
                "tool_call"
            },
            if script.direct.load(std::sync::atomic::Ordering::SeqCst) {
                script.args.lock().unwrap().clone()
            } else {
                json!({"id":"native:canon_propose","arguments":*script.args.lock().unwrap()})
            },
        ))
    } else if script.retry.load(std::sync::atomic::Ordering::SeqCst) && !done("propose-retry") {
        Some((
            "propose-retry",
            "tool_call",
            json!({"id":"native:canon_propose","arguments":*script.args.lock().unwrap()}),
        ))
    } else if !done("propose-close") {
        Some((
            "propose-close",
            "record_work_disposition",
            closeout(&work, &outputs),
        ))
    } else {
        None
    };
    let item = if let Some((id, name, args)) = call {
        json!({"type":"function_call","id":id,"call_id":id,"name":name,"arguments":args.to_string(),"status":"completed"})
    } else {
        json!({"type":"message","id":"propose-report","role":"assistant","status":"completed",
            "content":[{"type":"output_text","text":"Board request handled.","annotations":[]}]})
    };
    (
        [("content-type", "text/event-stream")],
        crate::token_cache::wire(&item),
    )
}
fn work_id(value: &Value) -> Option<String> {
    value
        .get("work_id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| value.as_object()?.values().find_map(work_id))
}

fn closeout(work: &str, outputs: &[Value]) -> Value {
    let applied = outputs
        .iter()
        .any(|v| v.get("ref").is_some() || v["output"].get("ref").is_some());
    if applied {
        json!({"work_id":work,"disposition":"completed","summary":"Board item created",
            "action_updates":[{"action_key":"create","status":"done"}]})
    } else {
        json!({"work_id":work,"disposition":"blocked","summary":"Board item was not created",
            "action_updates":[{"action_key":"create","status":"blocked"}],
            "remaining_actions":["create"],"next_condition":"A permitted valid request is available"})
    }
}
