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
    /// Each tool output the model received, in order.
    pub(super) outputs: Mutex<Vec<Value>>,
    /// Bytes of each complete model-facing tool output, including metadata.
    pub(super) output_bytes: Mutex<Vec<usize>>,
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
    *state.output_bytes.lock().unwrap() =
        output_texts(body).iter().map(|text| text.len()).collect();
    let outputs = outputs(body);
    *state.outputs.lock().unwrap() = outputs.clone();
    let first_url = || outputs[0]["results"][0]["url"].clone();
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
        2 => call(2, "web_read", &json!({"url":first_url()})),
        // The rest of the page: the same read, continued.
        3 => call(
            3,
            "web_read",
            &json!({"url":first_url(),"start_chunk":outputs[2]["next_start_chunk"],"max_chunks":8,"max_chars":8000}),
        ),
        4 => call(
            4,
            "browser_observe",
            &json!({"tab":outputs[1]["tabs"][0]["tab"]}),
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

/// Bytes the turn wrote per browser and web step: its tool journal rows and
/// its progress events (the transcript carries the same events).
pub(super) fn step_bytes(
    data: &std::path::Path,
    turn: &str,
    outputs: &[Value],
    output_bytes: &[usize],
) -> String {
    let db = butler_platform::sqlite::open_with_flags(
        data.join("agent-runtime/btcc.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let model_bytes = web_read_model_bytes(&db, turn, &outputs[2], output_bytes[2]);
    let mut journal = db
        .prepare(
            "SELECT tool_name, length(result_json) FROM btcc_guided_tool_calls WHERE turn_id=?1",
        )
        .unwrap();
    let rows = journal
        .query_map([turn], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1).unwrap_or(0)))
        })
        .unwrap()
        .flatten()
        .collect::<Vec<_>>();
    let mut events = db
        .prepare("SELECT event_json FROM btcc_progress_events WHERE turn_id=?1")
        .unwrap();
    let progress = events
        .query_map([turn], |r| r.get::<_, String>(0))
        .unwrap()
        .flatten()
        .filter(|e| e.contains("\"operation.output.chunk\"") || e.contains("\"tool."))
        .map(|e| e.len())
        .sum::<usize>();
    let journal = rows.iter().map(|(_, n)| *n).sum::<i64>();
    format!(
        "search-browser bytes: {} tool steps, journal {journal} B, progress {progress} B, {} B/step; {model_bytes}",
        rows.len(),
        (usize::try_from(journal).unwrap_or(0) + progress) / rows.len().max(1)
    )
}

/// Reconstruct the previous projection from the immutable stored result and
/// compare it with the model's actual first web_read output. The unchanged
/// envelope and metadata retain their actual wire size; host receipts stay
/// available to the App.
fn web_read_model_bytes(
    db: &rusqlite::Connection,
    turn: &str,
    model: &Value,
    after: usize,
) -> String {
    let raw: String = db.query_row(
        "SELECT result_json FROM btcc_guided_tool_calls WHERE turn_id=?1 AND tool_name='web_read' ORDER BY rowid LIMIT 1",
        [turn], |row| row.get(0),
    ).unwrap();
    let mut before: Value = serde_json::from_str(&raw).unwrap();
    before["tool_name"] = json!("web_read");
    let mut projected = before.clone();
    for key in [
        "evidence_receipts",
        "evidence_capability_receipts",
        "public_web_evidence_items",
    ] {
        assert!(
            before.get(key).is_some(),
            "stored host bookkeeping lost {key}"
        );
        projected.as_object_mut().unwrap().remove(key);
    }
    assert_eq!(&projected, model, "projection changed web content");
    let before = after + before.to_string().len() - model.to_string().len();
    assert!(
        before < 50 * 1024,
        "previous projection fit without a byte cut"
    );
    format!("web_read model output {before} -> {after} B (before reconstructed from stored result)")
}
