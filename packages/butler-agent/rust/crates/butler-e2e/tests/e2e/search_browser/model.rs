//! A scripted model and an offline search provider. The model researches the
//! way the tool contracts describe: search, open the results, read, look.
use axum::{
    Json, Router,
    extract::State,
    response::Response,
    routing::{get, post},
};
use butler_e2e::e2e::HarnessError;
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub(super) struct StateData {
    pub(super) page_fetches: std::sync::atomic::AtomicUsize,
    /// Each tool output the model received, in order.
    pub(super) outputs: Mutex<Vec<Value>>,
    /// The tools (name, description, parameters) of the first agent request.
    pub(super) tools: Mutex<Vec<Value>>,
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
    pub(super) async fn start() -> Result<Self, HarnessError> {
        let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}", socket.local_addr()?);
        let state = Arc::new(StateData::default());
        let app = Router::new()
            .route("/v1/responses", post(model))
            .route_layer(axum::middleware::from_fn(
                butler_e2e::e2e::chatgpt_wire::validate,
            ))
            .route("/search", get(search))
            .route("/report", get(report))
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

async fn report(State(state): State<Arc<StateData>>) -> axum::response::Html<String> {
    state
        .page_fetches
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    axum::response::Html(format!(
        "<html><title>Report</title><article><h1>Published report</h1><p>{}</p><p>End of the report.</p></article></html>",
        "The published report includes the complete source details and context. ".repeat(65)
    ))
}

async fn search() -> Json<Value> {
    let results = ["alpha", "beta", "gamma"].map(|name| {
        json!({"title":format!("Tide table {name}"),"url":format!("https://example.com/tides/{name}"),
            "description":format!("Published spring tide table ({name}).")})
    });
    Json(json!({"web":{"results":results}}))
}

async fn model(State(state): State<Arc<StateData>>, Json(body): Json<Value>) -> Response {
    let tools = butler_e2e::e2e::chatgpt_wire::functions(&body)
        .cloned()
        .collect::<Vec<_>>();
    let item = if tools.is_empty() {
        message("Tide tables")
    } else {
        next(&state, &body, &tools)
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

/// The next research step, from the tool outputs so far.
fn next(state: &StateData, body: &Value, tools: &[Value]) -> Value {
    {
        let mut seen = state.tools.lock().unwrap();
        if seen.is_empty() {
            *seen = tools
                .iter()
                .map(|t| json!({"name":t["name"],"description":t["description"],"parameters":t["parameters"]}))
                .collect();
        }
    }
    let outputs = outputs(body);
    *state.outputs.lock().unwrap() = outputs.clone();
    match outputs.len() {
        0 => call(0, "web_search", &json!({"query":"spring tide tables"})),
        1 => {
            let ids = outputs[0]["results"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|r| r["id"].clone())
                .collect::<Vec<_>>();
            call(1, "browser_open", &json!({"results":ids}))
        }
        2 => call(
            2,
            "browser_observe",
            &json!({"tab":outputs[1]["tabs"][0]["tab"],"look":"never"}),
        ),
        _ => message("The three tables agree: the highest spring tide is 6.1 m."),
    }
}

/// Every function output in the request, decoded.
pub(super) fn outputs(body: &Value) -> Vec<Value> {
    output_texts(body)
        .into_iter()
        .filter_map(|text| {
            let value: Value = serde_json::from_str(text).ok()?;
            Some(value.get("output").cloned().unwrap_or(value))
        })
        .collect()
}

fn output_texts(body: &Value) -> Vec<&str> {
    body["input"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| item["type"] == "function_call_output")
        .filter_map(|item| {
            let output = &item["output"];
            output.as_str().or_else(|| {
                output
                    .as_array()?
                    .iter()
                    .find(|p| p["type"] == "input_text")?["text"]
                    .as_str()
            })
        })
        .collect()
}

pub(super) fn call(round: usize, name: &str, args: &Value) -> Value {
    json!({"type":"function_call","id":format!("fc_research_{round}"),"call_id":format!("call_research_{round}"),"name":name,"arguments":args.to_string(),"status":"completed"})
}

pub(super) fn message(text: &str) -> Value {
    json!({"type":"message","id":"msg_research","role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]})
}
