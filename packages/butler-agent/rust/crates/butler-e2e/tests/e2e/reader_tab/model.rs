//! A model that follows the offered browser contracts on both provider wires:
//! open the page, observe its content, show answer blocks, then answer.
use axum::{Json, Router, extract::State, response::Response, routing::post};
use butler_e2e::e2e::HarnessError;
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Wire {
    Codex,
    Anthropic,
}

#[derive(Default)]
pub(super) struct StateData {
    /// Each tool output the model received, in order.
    pub(super) outputs: Mutex<Vec<Value>>,
    /// The system instructions and tools of the first agent request.
    pub(super) first: Mutex<Option<Value>>,
}

pub(super) struct Fixture {
    pub(super) base: String,
    state: Arc<StateData>,
    server: tokio::task::JoinHandle<()>,
}

impl std::ops::Deref for Fixture {
    type Target = StateData;
    fn deref(&self) -> &Self::Target {
        &self.state
    }
}

impl Fixture {
    pub(super) async fn start(wire: Wire) -> Result<Self, HarnessError> {
        let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}", socket.local_addr()?);
        let state = Arc::new(StateData::default());
        let app = match wire {
            Wire::Codex => Router::new().route("/v1/responses", post(codex)),
            Wire::Anthropic => Router::new().route("/v1/messages", post(anthropic)).route(
                "/v1/models",
                axum::routing::get(|| async { Json(json!({"data":[]})) }),
            ),
        }
        .with_state(state.clone());
        let server = tokio::spawn(async move {
            axum::serve(socket, app).await.unwrap();
        });
        Ok(Self {
            base,
            state,
            server,
        })
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

/// The next step, from the tool outputs so far: `(tool, arguments)` or the
/// final answer when `None`.
fn next(outputs: &[Value]) -> Option<(&'static str, Value)> {
    match outputs.len() {
        0 => Some(("browser_open", json!({"url":super::PAGE}))),
        1 => Some((
            "browser_observe",
            json!({"tab":outputs[0]["tab"],"scope":"text","look":"never"}),
        )),
        2 => Some(("answer_blocks", blocks(&outputs[1]))),
        _ => None,
    }
}

const ANSWER: &str = "The Beacon is the brightest of the three lamps.";

/// The comparison of the read page's candidates, each value sourced to it.
fn blocks(read: &Value) -> Value {
    let source = read["untrusted_content"]["url"].clone();
    let checked = chrono::Utc::now().to_rfc3339();
    let lamps = [("Aurora", 450), ("Beacon", 1200), ("Cinder", 800)];
    let cards = lamps.map(|(name, lumens)| {
        json!({"title":name,"value":{"amount":lumens,"unit":"lm"},"source":source,"checked":checked})
    });
    let rows = lamps.map(|(name, lumens)| json!([name, lumens]));
    json!({"v":1,"blocks":[{"type":"cards","id":"lamps","items":cards},
        {"type":"table","id":"brightness","columns":["Lamp","Lumens"],"rows":rows}]})
}

fn remember_first(state: &StateData, body: &Value, system: &Value) {
    let mut first = state.first.lock().unwrap();
    if first.is_none() {
        *first = Some(json!({"system":system,"tools":body["tools"]}));
    }
}

async fn codex(State(state): State<Arc<StateData>>, Json(body): Json<Value>) -> Response {
    let item = if body["tools"].as_array().is_some_and(|t| !t.is_empty()) {
        remember_first(&state, &body, &body["instructions"]);
        let outputs = decode(
            body["input"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|item| item["type"] == "function_call_output")
                .map(|item| &item["output"]),
        );
        *state.outputs.lock().unwrap() = outputs.clone();
        match next(&outputs) {
            Some((name, args)) => {
                let round = outputs.len();
                json!({"type":"function_call","id":format!("fc_tab_{round}"),"call_id":format!("call_tab_{round}"),
                    "name":name,"arguments":args.to_string(),"status":"completed"})
            }
            None => message(ANSWER),
        }
    } else {
        message("Desk lamps")
    };
    let record = crate::browser_usage::stub::response(&item);
    let model = body["model"].as_str().unwrap_or("gpt-6-luna").to_owned();
    let stream = futures_util::stream::iter(record.chunks).map(move |chunk| {
        Ok::<_, std::io::Error>(bytes::Bytes::from(chunk.text.replace("gpt-6-sol", &model)))
    });
    axum::http::Response::builder()
        .header("content-type", "text/event-stream")
        .body(axum::body::Body::from_stream(stream))
        .unwrap()
}

fn message(text: &str) -> Value {
    json!({"type":"message","id":"msg_tab","role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]})
}

async fn anthropic(State(state): State<Arc<StateData>>, Json(body): Json<Value>) -> Json<Value> {
    let tools = body["tools"].as_array().is_some_and(|t| !t.is_empty());
    let step = if tools {
        remember_first(&state, &body, &body["system"]);
        let outputs = decode(
            body["messages"]
                .as_array()
                .into_iter()
                .flatten()
                .flat_map(|m| m["content"].as_array().into_iter().flatten())
                .filter(|block| block["type"] == "tool_result")
                .map(|block| &block["content"]),
        );
        *state.outputs.lock().unwrap() = outputs.clone();
        next(&outputs).map(|step| (outputs.len(), step))
    } else {
        None
    };
    let (content, stop) = match step {
        Some((round, (name, input))) => (
            json!([{"type":"tool_use","id":format!("toolu_tab_{round}"),"name":name,"input":input}]),
            "tool_use",
        ),
        None => (
            json!([{"type":"text","text":if tools { ANSWER } else { "Desk lamps" }}]),
            "end_turn",
        ),
    };
    Json(
        json!({"id":"msg_tab","type":"message","role":"assistant","model":body["model"],
        "content":content,"stop_reason":stop,"usage":{"input_tokens":100,"output_tokens":10}}),
    )
}

/// Each tool output as JSON: a string, or text parts on either wire.
fn decode<'a>(outputs: impl Iterator<Item = &'a Value>) -> Vec<Value> {
    outputs
        .filter_map(|output| {
            let text = match output {
                Value::String(text) => text.clone(),
                Value::Array(parts) => parts
                    .iter()
                    .filter_map(|part| part["text"].as_str())
                    .collect::<String>(),
                _ => return None,
            };
            let value: Value = serde_json::from_str(&text).ok()?;
            Some(value.get("output").cloned().unwrap_or(value))
        })
        .collect()
}
