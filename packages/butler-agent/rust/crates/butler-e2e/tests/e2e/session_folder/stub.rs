//! Scripted model rounds keyed by the user request; a steward child's
//! requests share one script.
#![allow(clippy::unwrap_used, reason = "E2E fixture state")]

use axum::{Json, Router, extract::State, response::IntoResponse, routing::post};
use butler_e2e::e2e::{HarnessError, matching, sanitize::Placeholders};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

pub(super) const CHILD: &str = "role: steward";

#[derive(Default)]
pub(super) struct Script {
    pub(super) rounds: Mutex<HashMap<String, Vec<Value>>>,
    pub(super) requests: Mutex<Vec<Value>>,
}

impl Script {
    pub(super) fn set(&self, prompt: &str, rounds: Vec<Value>) {
        self.rounds.lock().unwrap().insert(prompt.into(), rounds);
    }

    /// The tool outputs the model received for `prompt`, by call id.
    pub(super) fn outputs(&self, prompt: &str) -> HashMap<String, String> {
        let requests = self.requests.lock().unwrap();
        let mut outputs = HashMap::new();
        for request in requests.iter().filter(|r| key(r).starts_with(prompt)) {
            for item in request["input"].as_array().into_iter().flatten() {
                if item["type"] == "function_call_output" {
                    outputs.insert(
                        item["call_id"].as_str().unwrap_or_default().to_owned(),
                        item["output"].as_str().unwrap_or_default().to_owned(),
                    );
                }
            }
        }
        outputs
    }
}

fn key(body: &Value) -> String {
    matching::key("/v1/responses", body, &Placeholders::default()).user_request
}

pub(super) async fn start()
-> Result<(String, Arc<Script>, tokio::task::JoinHandle<()>), HarnessError> {
    let script = Arc::new(Script::default());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}", listener.local_addr()?);
    let app = Router::new()
        .route("/v1/responses", post(reply))
        .route_layer(axum::middleware::from_fn(
            butler_e2e::e2e::chatgpt_wire::validate,
        ))
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
    let request = key(&body);
    let prompt = if request.starts_with(CHILD) {
        CHILD.to_owned()
    } else {
        request
    };
    let mut requests = script.requests.lock().unwrap();
    let step = requests
        .iter()
        .filter(|r| {
            let k = key(r);
            if prompt == CHILD {
                k.starts_with(CHILD)
            } else {
                k == prompt
            }
        })
        .count();
    let work = work_id(&body);
    requests.push(body);
    let item = script
        .rounds
        .lock()
        .unwrap()
        .get(&prompt)
        .and_then(|rounds| rounds.get(step))
        .cloned()
        .unwrap_or_else(|| message("Done."));
    let item: Value = serde_json::from_str(&item.to_string().replace("{{WORK}}", &work)).unwrap();
    (
        [("content-type", "text/event-stream")],
        super::super::token_cache::wire(&item),
    )
        .into_response()
}

fn work_id(body: &Value) -> String {
    body["input"]
        .as_array()
        .into_iter()
        .flatten()
        .rev()
        .filter_map(|item| item["output"].as_str())
        .filter_map(|s| serde_json::from_str::<Value>(s).ok())
        .find_map(|v| {
            v.pointer("/output/work/work_id")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_default()
}

pub(super) fn call(id: &str, name: &str, args: &Value) -> Value {
    // The arguments may name {{WORK}}, filled from the turn's Work.
    json!({"type":"function_call","id":format!("fc_{id}"),"call_id":id,"name":name,"arguments":args.to_string(),"status":"completed"})
}

pub(super) fn message(text: &str) -> Value {
    json!({"type":"message","id":"msg_done","role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]})
}

pub(super) fn command(id: &str, command: &str, effect: &str) -> Value {
    call(
        id,
        "run_command",
        &json!({"command":command,"summary":"Run","state_effect":effect}),
    )
}
