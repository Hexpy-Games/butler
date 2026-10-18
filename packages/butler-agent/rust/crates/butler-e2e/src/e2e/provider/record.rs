//! Record side of the provider: forward to the live upstream, stream the
//! reply back, keep a sanitized copy per SSE event.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{HeaderMap, Response};
use bytes::Bytes;
use futures_util::StreamExt;
use tokio::sync::mpsc;

use super::super::cassette::{self, Chunk, Exchange, RequestRecord, ResponseRecord};
use super::super::faults::{ArgsMutation, Transform, mutate_chunk};
use super::super::sanitize::{keep_header, sanitize_body};
use super::replay::{consume_fault, plain, take_fault};
use super::{State, lock};

#[expect(clippy::too_many_arguments, reason = "one forwarding step, kept flat")]
pub(super) async fn record(
    state: &Arc<State>,
    upstream: &str,
    client: &reqwest::Client,
    method: &axum::http::Method,
    headers: &HeaderMap,
    path: String,
    key: cassette::MatchKey,
    body: Bytes,
) -> Response<Body> {
    eprintln!(
        "RECORD {} {path} key={}",
        method.as_str(),
        serde_json::to_string(&key).unwrap_or_default()
    );
    let mut request = client.request(
        reqwest::Method::from_bytes(method.as_str().as_bytes()).unwrap_or(reqwest::Method::POST),
        format!("{}{path}", upstream.trim_end_matches('/')),
    );
    for (name, value) in headers {
        if !matches!(name.as_str(), "host" | "content-length" | "connection") {
            request = request.header(name.as_str(), value.as_bytes());
        }
    }
    let (fault_position, mutation) = match take_fault(state, None, &key) {
        Some((position, Transform::MutateToolArgs(mutation))) => (Some(position), Some(mutation)),
        _ => (None, None),
    };
    let upstream_response = match request.body(body).send().await {
        Ok(response) => response,
        Err(error) => return plain(502, &format!("HARNESS_ERROR: upstream failed: {error}")),
    };
    state
        .inflight
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let status = upstream_response.status().as_u16();
    let mut kept_headers = Vec::new();
    let mut builder = Response::builder().status(status);
    for (name, value) in upstream_response.headers() {
        if matches!(
            name.as_str(),
            "content-length" | "transfer-encoding" | "connection" | "content-encoding"
        ) {
            continue;
        }
        builder = builder.header(name.as_str(), value.as_bytes());
        if let Ok(value) = value.to_str()
            && keep_header(name.as_str(), value)
        {
            kept_headers.push((name.as_str().to_owned(), value.to_owned()));
        }
    }
    let (sender, receiver) = mpsc::channel::<Result<Bytes, std::io::Error>>(64);
    let recording = Recording {
        state: state.clone(),
        request: RequestRecord {
            method: method.as_str().to_owned(),
            path,
            key,
        },
        status,
        headers: kept_headers,
        fault_position,
        mutation,
    };
    tokio::spawn(relay(recording, upstream_response, sender));
    let stream = futures_util::stream::unfold(receiver, |mut receiver| async move {
        receiver.recv().await.map(|item| (item, receiver))
    });
    builder
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| plain(502, "HARNESS_ERROR: bad upstream response"))
}

/// What one forwarded exchange keeps for the cassette while it streams.
struct Recording {
    state: Arc<State>,
    request: RequestRecord,
    status: u16,
    headers: Vec<(String, String)>,
    fault_position: Option<usize>,
    mutation: Option<ArgsMutation>,
}

/// Streams the upstream reply to the product (rewritten when a tool-argument
/// mutation applies) and records it, one sanitized chunk per SSE event.
async fn relay(
    mut recording: Recording,
    upstream_response: reqwest::Response,
    sender: mpsc::Sender<Result<Bytes, std::io::Error>>,
) {
    let state = recording.state.clone();
    let mutation = recording.mutation.take();
    let mut stream = upstream_response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();
    let mut events: Vec<(u64, Vec<u8>)> = Vec::new();
    let mut last = Instant::now();
    while let Some(next) = stream.next().await {
        let Ok(bytes) = next else {
            let _ = sender
                .send(Err(std::io::Error::other("upstream stream error")))
                .await;
            break;
        };
        if mutation.is_none() {
            let _ = sender.send(Ok(bytes.clone())).await;
        }
        buffer.extend_from_slice(&bytes);
        while let Some(end) = find(&buffer, b"\n\n") {
            let event: Vec<u8> = buffer.drain(..end + 2).collect();
            if let Some(mutation) = &mutation {
                let original = String::from_utf8_lossy(&event).into_owned();
                let text = mutate_chunk(&original, mutation);
                if text != original
                    && let Some(position) = recording.fault_position.take()
                {
                    consume_fault(&state, position);
                }
                let _ = sender.send(Ok(Bytes::from(text))).await;
            }
            let now = Instant::now();
            events.push((millis(now.duration_since(last)), event));
            last = now;
        }
    }
    if !buffer.is_empty() {
        if mutation.is_some() {
            let _ = sender.send(Ok(Bytes::from(buffer.clone()))).await;
        }
        events.push((millis(Instant::now().duration_since(last)), buffer));
    }
    let placeholders = lock(&state.placeholders).clone();
    let chunks = events
        .into_iter()
        .map(|(delay_ms, bytes)| Chunk {
            delay_ms,
            text: sanitize_body(&String::from_utf8_lossy(&bytes), &placeholders),
        })
        .collect();
    lock(&state.recorded).push(Exchange {
        request: recording.request,
        response: ResponseRecord {
            status: recording.status,
            headers: recording.headers,
            chunks,
        },
    });
    state
        .inflight
        .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
}

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}
