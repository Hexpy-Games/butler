#![allow(clippy::expect_used, reason = "E2E fixture state")]
use axum::{Json, Router, extract::State, response::IntoResponse, routing::post};
use butler_e2e::e2e::{HarnessError, matching, sanitize::Placeholders};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

#[derive(Default)]
pub(crate) struct Script {
    pub rounds: Mutex<HashMap<String, Vec<Value>>>,
    pub requests: Mutex<Vec<Value>>,
}
impl Script {
    pub(crate) fn requests_for(&self, prompt: &str) -> Vec<Value> {
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
pub(crate) async fn start()
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
    let work = work_id(&body);
    requests.push(body);
    // Rounds keyed by a prefix serve turns whose full request text is
    // rendered by Butler (a delegated steward's packet, a delegated result).
    let rounds = script.rounds.lock().expect("script lock");
    let round = rounds.get(&key.user_request).or_else(|| {
        rounds
            .iter()
            .find(|(prefix, _)| key.user_request.starts_with(prefix.as_str()))
            .map(|(_, round)| round)
    });
    let item = round.and_then(|r| r.get(step)).cloned()
        .unwrap_or_else(|| json!({"type":"message","id":"msg_done","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Checked.","annotations":[]}]}));
    let item: Value = serde_json::from_str(&item.to_string().replace("{{WORK}}", &work))
        .expect("stub item");
    (
        [("content-type", "text/event-stream")],
        super::super::token_cache::wire(&item),
    )
        .into_response()
}
pub(crate) fn call(id: &str, name: &str, args: &Value) -> Value {
    json!({"type":"function_call","id":format!("fc_{id}"),"call_id":id,"name":name,"arguments":args.to_string(),"status":"completed"})
}
/// The Work id the newest tool output of this request reported, for
/// `{{WORK}}` placeholders in scripted calls.
fn work_id(body: &Value) -> String {
    body["input"]
        .as_array()
        .into_iter()
        .flatten()
        .rev()
        .filter_map(|item| item["output"].as_str())
        .filter_map(|output| serde_json::from_str::<Value>(output).ok())
        .find_map(|value| {
            value
                .pointer("/output/work/work_id")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_default()
}
