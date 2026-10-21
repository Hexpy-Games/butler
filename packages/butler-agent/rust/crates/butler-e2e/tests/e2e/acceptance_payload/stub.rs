//! Synthetic codex server; capture the literal input bytes received on the wire.
use axum::{
    Router,
    body::Bytes,
    extract::{DefaultBodyLimit, State},
    response::IntoResponse,
    routing::post,
};
use butler_e2e::e2e::{HarnessError, matching, sanitize::Placeholders};
use serde_json::{Value, json, value::RawValue};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
pub(in super::super) const REQUEST: &str = "Inspect the synthetic workspace and report the result.";
pub(in super::super) struct Script {
    pub requests: Mutex<Vec<usize>>,
    pub input: Mutex<String>,
    pub held: tokio::sync::Notify,
    pub release: tokio::sync::Notify,
    pub hold: AtomicBool,
    pub root: String,
    pub rounds: usize,
}
pub(in super::super) async fn start(
    root: String,
    rounds: usize,
) -> Result<(String, Arc<Script>, tokio::task::JoinHandle<()>), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/codex", listener.local_addr()?);
    let script = Arc::new(Script {
        requests: Mutex::new(vec![]),
        input: Mutex::new(String::new()),
        held: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
        hold: AtomicBool::new(true),
        root,
        rounds,
    });
    let app = Router::new()
        // The history synthetic input is about 2.4 MB; retain the complete body.
        .route("/codex/responses", post(reply))
        .layer(DefaultBodyLimit::max(8 * 1024 * 1024))
        .with_state(script.clone());
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok((url, script, server))
}
async fn reply(State(script): State<Arc<Script>>, raw: Bytes) -> axum::response::Response {
    let body: Value = serde_json::from_slice(&raw).unwrap();
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
                        .is_some_and(|id| id.starts_with("acc-call-"))
            })
            .count();
        script.requests.lock().unwrap().push(step);
        if step == script.rounds {
            let fields: BTreeMap<String, Box<RawValue>> = serde_json::from_slice(&raw).unwrap();
            *script.input.lock().unwrap() = fields["input"].get().to_owned();
            script.held.notify_one();
            if script.hold.load(Ordering::SeqCst) {
                script.release.notified().await;
            }
            message("Inspection complete.")
        } else {
            // Arbitrary provider fields also test object key order and numeric keys.
            json!({"type":"function_call","id":format!("fc_acc-{step}"),"call_id":format!("acc-call-{step}"),"name":"list_files",
                "arguments":json!({"root":script.root}).to_string(),"status":"completed",
                "extension":{"z":step,"a":true,"2":"numeric-key"},"syntheticPadding":format!("round-{step}:{}", "synthetic data ".repeat(393))})
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
    json!({"type":"message","id":"msg_acc","role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]})
}
