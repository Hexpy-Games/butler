//! Synthetic replies for load scenarios: no cassette, the model side is a
//! script (`rounds` tool calls, then a final answer) and the provider keeps
//! the clock of every exchange, so a scenario can measure what the product
//! spends between the end of one model reply and the next request.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::Response;
use bytes::Bytes;
use futures_util::StreamExt;
use serde_json::{Value, json};

use super::lock;

/// What the scripted model does: read one file per round, then answer.
pub struct Script {
    pub rounds: usize,
    pub path_for: Box<dyn Fn(usize) -> String + Send + Sync>,
    pub final_text: String,
}

/// One request/response exchange as the provider saw it.
#[derive(Clone, Copy, Debug)]
pub struct Timing {
    /// The whole request had arrived.
    pub arrived: Instant,
    /// The reply stream had been handed to the connection; `None` while open.
    pub replied: Option<Instant>,
    pub request_bytes: usize,
}

pub(super) struct Synthetic {
    script: Script,
    log: Mutex<Vec<Timing>>,
}

impl Synthetic {
    pub(super) fn new(script: Script) -> Arc<Self> {
        Arc::new(Self {
            script,
            log: Mutex::new(Vec::new()),
        })
    }

    pub(super) fn timings(&self) -> Vec<Timing> {
        lock(&self.log).clone()
    }

    /// Answers the request `body` (a Responses API request).
    pub(super) fn respond(self: &Arc<Self>, body: &Value, request_bytes: usize) -> Response<Body> {
        let index = {
            let mut log = lock(&self.log);
            log.push(Timing {
                arrived: Instant::now(),
                replied: None,
                request_bytes,
            });
            log.len() - 1
        };
        let outputs = body["input"].as_array().map_or(0, |items| {
            items
                .iter()
                .filter(|item| item["type"] == "function_call_output")
                .count()
        });
        let events = if outputs < self.script.rounds {
            call_events(index, &(self.script.path_for)(outputs))
        } else {
            answer_events(index, &self.script.final_text)
        };
        let owner = self.clone();
        let stream = futures_util::stream::iter(events.into_iter().map(Bytes::from))
            .map(Ok::<_, std::io::Error>)
            .chain(
                futures_util::stream::once(async move {
                    if let Some(timing) = lock(&owner.log).get_mut(index) {
                        timing.replied = Some(Instant::now());
                    }
                })
                .filter_map(|()| async { None }),
            );
        let mut response = Response::new(Body::from_stream(stream));
        response.headers_mut().insert(
            "content-type",
            axum::http::HeaderValue::from_static("text/event-stream"),
        );
        response
    }
}

/// Gaps between a reply's end and the next request's arrival: the runtime's
/// own time per round, model excluded.
pub fn round_overheads(timings: &[Timing]) -> Vec<Duration> {
    timings
        .windows(2)
        .filter_map(|pair| {
            pair[0]
                .replied
                .map(|replied| pair[1].arrived.saturating_duration_since(replied))
        })
        .collect()
}

fn frame(event: &Value) -> String {
    format!(
        "event: {}\ndata: {event}\n\n",
        event["type"].as_str().unwrap_or("")
    )
}

fn completed(index: usize) -> Value {
    json!({"type":"response.completed","response":{
        "id":format!("resp_synthetic{index}"),"object":"response","status":"completed",
        "model":"gpt-6-sol","output":[],
        "usage":{"input_tokens":1000,"output_tokens":20,"total_tokens":1020,
                 "input_tokens_details":{"cached_tokens":0}}},
        "sequence_number":9})
}

fn call_events(index: usize, path: &str) -> Vec<String> {
    let arguments = json!({"requests":[{"path":path}]}).to_string();
    let item = json!({"id":format!("fc_synthetic{index}"),"type":"function_call",
        "status":"completed","arguments":arguments,
        "call_id":format!("call_synthetic{index}"),"name":"read_file"});
    vec![
        frame(
            &json!({"type":"response.created","response":{"id":format!("resp_synthetic{index}"),
            "status":"in_progress","output":[]},"sequence_number":0}),
        ),
        frame(&json!({"type":"response.output_item.done","item":item,
            "output_index":0,"sequence_number":1})),
        frame(&completed(index)),
    ]
}

fn answer_events(index: usize, text: &str) -> Vec<String> {
    let item = json!({"id":format!("msg_synthetic{index}"),"type":"message","status":"completed",
        "content":[{"type":"output_text","annotations":[],"text":text}],
        "phase":"final_answer","role":"assistant"});
    vec![
        frame(
            &json!({"type":"response.created","response":{"id":format!("resp_synthetic{index}"),
            "status":"in_progress","output":[]},"sequence_number":0}),
        ),
        frame(
            &json!({"type":"response.output_text.delta","item_id":item["id"],
            "delta":text,"output_index":0,"sequence_number":1}),
        ),
        frame(&json!({"type":"response.output_item.done","item":item,
            "output_index":0,"sequence_number":2})),
        frame(&completed(index)),
    ]
}
