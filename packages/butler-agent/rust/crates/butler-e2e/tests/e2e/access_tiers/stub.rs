#![allow(clippy::expect_used, reason = "E2E fixture state")]
use axum::{Json, Router, extract::State, response::IntoResponse, routing::post};
use butler_e2e::e2e::{HarnessError, matching, sanitize::Placeholders};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

#[derive(Default)]
pub(super) struct Script {
    pub rounds: Mutex<HashMap<String, Vec<Value>>>,
    pub requests: Mutex<Vec<Value>>,
}
impl Script {
    pub(super) fn requests_for(&self, prompt: &str) -> Vec<Value> {
        self.requests
            .lock()
            .expect("script lock")
            .iter()
            .filter(|request| {
                matching::key("/codex/responses", request, &Placeholders::default()).user_request
                    == prompt
            })
            .cloned()
            .collect()
    }
}
pub(super) async fn start()
-> Result<(String, Arc<Script>, tokio::task::JoinHandle<()>), HarnessError> {
    let script = Arc::new(Script::default());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}", listener.local_addr()?);
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
    let mut requests = script.requests.lock().expect("script lock");
    let step = requests
        .iter()
        .filter(|r| {
            matching::key("/codex/responses", r, &Placeholders::default()).user_request
                == key.user_request
        })
        .count();
    requests.push(body);
    let item = script.rounds.lock().expect("script lock").get(&key.user_request).and_then(|r| r.get(step)).cloned()
        .unwrap_or_else(|| json!({"type":"message","id":"msg_done","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Checked.","annotations":[]}]}));
    (
        [("content-type", "text/event-stream")],
        super::super::token_cache::wire(&item),
    )
        .into_response()
}
pub(super) fn call(id: &str, name: &str, args: &Value) -> Value {
    json!({"type":"function_call","id":format!("fc_{id}"),"call_id":id,"name":name,"arguments":args.to_string(),"status":"completed"})
}
