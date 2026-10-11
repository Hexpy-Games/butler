use axum::{
    Json, Router,
    extract::{Query, State},
    response::Response,
    routing::{get, post},
};
use butler_e2e::e2e::HarnessError;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

#[derive(Default)]
pub(super) struct StateData {
    rounds: AtomicUsize,
    active: AtomicUsize,
    pub(super) parallel: AtomicUsize,
    pub(super) planners: AtomicUsize,
    pub(super) outputs: Mutex<Vec<Value>>,
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
            .route("/codex/responses", post(model))
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

async fn model(State(state): State<Arc<StateData>>, Json(body): Json<Value>) -> Response {
    let planning = body["instructions"]
        .as_str()
        .unwrap_or("")
        .contains("Smart Search Planning");
    let item = if planning {
        state.planners.fetch_add(1, Ordering::SeqCst);
        assert_eq!(body["model"], "gpt-6-luna");
        assert_eq!(body["reasoning"]["effort"], "low");
        message(&json!({"depth":"deep","intent":"compare sources","scope":"comparison",
            "decomposition":[{"id":"sources","label":"Sources","priority":"high"}],
            "queries":(["alpha","beta","gamma"].map(|q|json!({"bucketId":"sources","query":q,"purpose":"comparison","priority":"high","expectedSourceType":"review"}))),
            "verificationRequired":true}).to_string())
    } else {
        capture(&state, &body);
        let round = state.rounds.fetch_add(1, Ordering::SeqCst);
        match round {
            0 => call(
                round,
                "tool_describe",
                &json!({"ids":["native:web_search","native:web_read"]}),
            ),
            1..=4 => call(
                round,
                "tool_call",
                &json!({"id":"native:web_search","arguments":{"query":format!("source {round}"),"max_results":if round==1 {10}else{5}}}),
            ),
            5 => call(
                round,
                "tool_call",
                &json!({"id":"native:web_read","arguments":{"url":"https://example.com/fixture"}}),
            ),
            _ => message("Complete."),
        }
    };
    let mut record = crate::browser_usage::stub::response(&item);
    for chunk in &mut record.chunks {
        chunk.text = chunk
            .text
            .replace("gpt-6-sol", body["model"].as_str().unwrap());
    }
    let stream = futures_util::stream::iter(record.chunks.into_iter().enumerate()).then(
        |(i, chunk)| async move {
            if i == 2 {
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
            Ok::<_, std::io::Error>(bytes::Bytes::from(chunk.text))
        },
    );
    axum::http::Response::builder()
        .header("content-type", "text/event-stream")
        .body(axum::body::Body::from_stream(stream))
        .unwrap()
}

fn capture(state: &StateData, body: &Value) {
    let Some(items) = body["input"].as_array() else {
        return;
    };
    let Some(item) = items
        .iter()
        .rev()
        .find(|item| item["type"] == "function_call_output")
    else {
        return;
    };
    let output = &item["output"];
    let text = output.as_str().or_else(|| {
        output
            .as_array()
            .and_then(|parts| parts.iter().find(|p| p["type"] == "input_text"))
            .and_then(|p| p["text"].as_str())
    });
    if let Some(Ok(value)) = text.map(serde_json::from_str::<Value>) {
        state
            .outputs
            .lock()
            .unwrap()
            .push(value.get("output").cloned().unwrap_or(value));
    }
}

fn call(round: usize, name: &str, args: &Value) -> Value {
    json!({"type":"function_call","id":format!("fc_speed_{round}"),"call_id":format!("call_speed_{round}"),"name":name,"arguments":args.to_string(),"status":"completed"})
}

fn message(text: &str) -> Value {
    json!({"type":"message","id":"msg_speed","role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]})
}

pub(super) fn snippet(query: &str, row: usize) -> String {
    format!(
        "Full snippet {query}/{row}: {}",
        "All source details are retained. ".repeat(60)
    )
}

async fn search(
    State(state): State<Arc<StateData>>,
    Query(query): Query<HashMap<String, String>>,
) -> Json<Value> {
    let active = state.active.fetch_add(1, Ordering::SeqCst) + 1;
    state.parallel.fetch_max(active, Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(80)).await;
    state.active.fetch_sub(1, Ordering::SeqCst);
    let q = query.get("q").unwrap();
    Json(
        json!({"web":{"results":(0..5).map(|i|json!({"title":format!("{q}/{i}"),"url":format!("https://example.com/{q}/{i}"),"description":snippet(q,i)})).collect::<Vec<_>>()}}),
    )
}

use futures_util::StreamExt;
