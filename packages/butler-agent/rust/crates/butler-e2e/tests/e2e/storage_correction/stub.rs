//! Six tool rounds; round four stays blocked across the correction restart.
use axum::{Json, Router, extract::State, response::IntoResponse, routing::post};
use butler_e2e::e2e::{HarnessError, matching, sanitize::Placeholders};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
pub(super) const REQUEST: &str = "Inspect the workspace six times and report the result.";
pub(super) struct Script {
    pub requests: Mutex<Vec<Value>>,
    pub held: tokio::sync::Notify,
    pub release: tokio::sync::Notify,
    pub hold: AtomicBool,
    pub root: String,
}
pub(super) async fn start(
    root: String,
) -> Result<(String, Arc<Script>, tokio::task::JoinHandle<()>), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/codex", listener.local_addr()?);
    let script = Arc::new(Script {
        requests: Mutex::new(vec![]),
        held: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
        hold: AtomicBool::new(true),
        root,
    });
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
    let item = if key.user_request == REQUEST {
        let step = body["input"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| {
                v["type"] == "function_call_output"
                    && v["call_id"]
                        .as_str()
                        .is_some_and(|id| id.starts_with("corr-call-"))
            })
            .count();
        script.requests.lock().unwrap().push(body);
        if step == 3 && script.hold.load(Ordering::SeqCst) {
            script.held.notify_one();
            script.release.notified().await;
        }
        if step < 6 {
            json!({"type":"function_call","id":format!("fc_corr-{step}"),"call_id":format!("corr-call-{step}"),"name":"list_files","arguments":json!({"root":script.root}).to_string(),"status":"completed"})
        } else {
            message("Inspection complete.")
        }
    } else {
        message("{}")
    };
    (
        [("content-type", "text/event-stream")],
        super::super::token_cache::wire(&item),
    )
        .into_response()
}
fn message(text: &str) -> Value {
    json!({"type":"message","id":"msg_corr","role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]})
}
