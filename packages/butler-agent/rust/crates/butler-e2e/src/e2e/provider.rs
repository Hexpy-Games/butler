//! Record/replay model provider: a local HTTP server the product reaches
//! through its own base-URL settings.
//!
//! - Replay: strict. Each request's match key must equal a recorded key; the
//!   n-th identical request gets the n-th recording (the last one repeats for
//!   retried identical requests). A miss answers 501 and is reported as a
//!   `HARNESS_ERROR` by [`Provider::finish`] — never a fallback reply.
//! - Record: forwards to the live upstream, streams the reply back unchanged,
//!   and keeps a sanitized copy (one chunk per SSE event, with arrival delay).

use std::convert::Infallible;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{HeaderMap, Request, Response, StatusCode};
use bytes::Bytes;
use futures_util::StreamExt;
use serde_json::Value;
use tokio::net::TcpListener;
use tokio::sync::mpsc;

use super::cassette::{self, Cassette, Chunk, Exchange, Meta, RequestRecord, ResponseRecord};
use super::faults::{Fault, Transform, mutate_chunk};
use super::matching;
use super::sanitize::{HEADER_ALLOWLIST, Placeholders, sanitize_body};
use super::{HarnessError, harness_error};

/// Replay pacing: recorded delay × `scale`, capped at `cap_ms`, at least `min_ms`.
#[derive(Clone, Copy, Debug)]
pub struct Pacing {
    pub scale: f64,
    pub cap_ms: u64,
    pub min_ms: u64,
}

impl Default for Pacing {
    fn default() -> Self {
        Self {
            scale: 1.0,
            cap_ms: 20,
            min_ms: 0,
        }
    }
}

enum Mode {
    Replay(Cassette),
    Record {
        upstream: String,
        meta: Meta,
        client: reqwest::Client,
    },
}

struct State {
    mode: Mode,
    placeholders: Mutex<Placeholders>,
    hits: Mutex<Vec<u32>>,
    faults: Mutex<Vec<Fault>>,
    pacing: Mutex<Pacing>,
    misses: Mutex<Vec<String>>,
    recorded: Mutex<Vec<Exchange>>,
    served: Mutex<u32>,
    inflight: std::sync::atomic::AtomicUsize,
    library: Mutex<Vec<(String, ResponseRecord)>>,
}

pub struct Provider {
    pub base_url: String,
    state: Arc<State>,
    server: tokio::task::JoinHandle<()>,
    written: bool,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Provider {
    pub async fn replay(
        cassette: Cassette,
        placeholders: Placeholders,
    ) -> Result<Self, HarnessError> {
        let count = cassette.exchanges.len();
        Self::serve(Mode::Replay(cassette), placeholders, count).await
    }

    pub async fn record(
        upstream: String,
        meta: Meta,
        placeholders: Placeholders,
    ) -> Result<Self, HarnessError> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(600))
            .build()?;
        Self::serve(
            Mode::Record {
                upstream,
                meta,
                client,
            },
            placeholders,
            0,
        )
        .await
    }

    async fn serve(
        mode: Mode,
        placeholders: Placeholders,
        count: usize,
    ) -> Result<Self, HarnessError> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let state = Arc::new(State {
            mode,
            placeholders: Mutex::new(placeholders),
            hits: Mutex::new(vec![0; count]),
            faults: Mutex::new(Vec::new()),
            pacing: Mutex::new(Pacing::default()),
            misses: Mutex::new(Vec::new()),
            recorded: Mutex::new(Vec::new()),
            served: Mutex::new(0),
            inflight: std::sync::atomic::AtomicUsize::new(0),
            library: Mutex::new(Vec::new()),
        });
        let shared = state.clone();
        let app = axum::Router::new().fallback(move |request: Request<Body>| {
            let state = shared.clone();
            async move { Ok::<_, Infallible>(handle(state, request).await) }
        });
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Ok(Self {
            base_url: format!("http://{address}"),
            written: !matches!(state.mode, Mode::Record { .. }),
            state,
            server,
        })
    }

    pub fn is_recording(&self) -> bool {
        matches!(self.state.mode, Mode::Record { .. })
    }

    pub fn inject(&self, fault: Fault) -> Result<(), HarnessError> {
        if let Transform::ErrorFromLibrary(name) = &fault.transform {
            let known = lock(&self.state.library).iter().any(|(n, _)| n == name);
            if !known {
                let errors = Cassette::load(&format!("_errors/{name}"))?;
                let response = errors
                    .exchanges
                    .into_iter()
                    .next()
                    .ok_or_else(|| harness_error(format!("error library {name} is empty")))?
                    .response;
                lock(&self.state.library).push((name.clone(), response));
            }
        }
        lock(&self.state.faults).push(fault);
        Ok(())
    }

    pub fn clear_faults(&self) {
        lock(&self.state.faults).clear();
    }

    pub fn set_pacing(&self, pacing: Pacing) {
        *lock(&self.state.pacing) = pacing;
    }

    pub fn add_placeholder(&self, name: &str, value: impl Into<String>) {
        lock(&self.state.placeholders).add(name, value);
    }

    /// Number of provider requests answered so far (harness bookkeeping).
    pub fn served(&self) -> u32 {
        *lock(&self.state.served)
    }

    /// Replay: fails on unmatched requests. Record: waits for in-flight
    /// exchanges (bounded) and writes the cassette.
    pub async fn finish(mut self) -> Result<(), HarnessError> {
        let misses = lock(&self.state.misses).clone();
        if matches!(self.state.mode, Mode::Record { .. }) {
            let deadline = Instant::now() + Duration::from_secs(120);
            while self
                .state
                .inflight
                .load(std::sync::atomic::Ordering::SeqCst)
                > 0
                && Instant::now() < deadline
            {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            self.write_recording()?;
        }
        self.server.abort();
        if misses.is_empty() {
            Ok(())
        } else {
            Err(harness_error(format!(
                "unmatched provider request(s) (strict replay):\n{}",
                misses.join("\n")
            )))
        }
    }
}

impl Provider {
    /// Record mode: writes what was captured so far (once).
    fn write_recording(&mut self) -> Result<(), HarnessError> {
        if self.written {
            return Ok(());
        }
        self.written = true;
        if let Mode::Record { meta, .. } = &self.state.mode {
            let exchanges = lock(&self.state.recorded).clone();
            let dir = cassette::root().join(&meta.scenario);
            cassette::write(&dir, meta.clone(), &exchanges)?;
            eprintln!(
                "RECORDED {} exchange(s) into {}",
                exchanges.len(),
                dir.display()
            );
        }
        Ok(())
    }
}

impl Drop for Provider {
    fn drop(&mut self) {
        // A failed scenario still keeps its recording for inspection.
        if let Err(error) = self.write_recording() {
            eprintln!("{error}");
        }
        self.server.abort();
    }
}

async fn handle(state: Arc<State>, request: Request<Body>) -> Response<Body> {
    *lock(&state.served) += 1;
    let (parts, body) = request.into_parts();
    let path = parts.uri.path().to_owned();
    let bytes = axum::body::to_bytes(body, 64 * 1024 * 1024)
        .await
        .unwrap_or_default();
    let json: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let key = matching::key(&path, &json, &lock(&state.placeholders));
    match &state.mode {
        Mode::Replay(cassette) => {
            let candidates: Vec<usize> = cassette
                .exchanges
                .iter()
                .enumerate()
                .filter(|(_, exchange)| exchange.request.key == key)
                .map(|(index, _)| index)
                .collect();
            let Some(&first) = candidates.first() else {
                lock(&state.misses).push(serde_json::to_string(&key).unwrap_or_default());
                return plain(501, "HARNESS_ERROR: no recording matches this request");
            };
            let hit = {
                let mut hits = lock(&state.hits);
                let seen = hits[first];
                hits[first] += 1;
                seen as usize
            };
            let index = candidates[hit.min(candidates.len() - 1)];
            let fault = take_fault(&state, index);
            replay(&state, &cassette.exchanges[index].response, fault)
        }
        Mode::Record {
            upstream, client, ..
        } => {
            record(
                &state,
                upstream,
                client,
                &parts.method,
                &parts.headers,
                path,
                key,
                bytes,
            )
            .await
        }
    }
}

fn take_fault(state: &State, index: usize) -> Option<Transform> {
    let mut faults = lock(&state.faults);
    let position = faults.iter().position(|fault| {
        fault.exchange.is_none_or(|target| target == index)
            && fault.remaining.is_none_or(|remaining| remaining > 0)
    })?;
    let fault = &mut faults[position];
    if let Some(remaining) = fault.remaining.as_mut() {
        *remaining -= 1;
    }
    Some(fault.transform.clone())
}

fn replay(state: &State, recorded: &ResponseRecord, fault: Option<Transform>) -> Response<Body> {
    let placeholders = lock(&state.placeholders).clone();
    let pacing = *lock(&state.pacing);
    let (response, limit, ending) = match fault {
        Some(Transform::ErrorFromLibrary(name)) => {
            let library = lock(&state.library);
            match library.iter().find(|(n, _)| *n == name) {
                Some((_, response)) => (response.clone(), usize::MAX, Ending::Clean),
                None => return plain(501, "HARNESS_ERROR: error library entry not loaded"),
            }
        }
        Some(Transform::TruncateAfter(k)) => (recorded.clone(), k, Ending::Clean),
        Some(Transform::ResetAfter(k)) => (recorded.clone(), k, Ending::Reset),
        Some(Transform::StallAfter(k)) => (recorded.clone(), k, Ending::Stall),
        Some(Transform::MutateToolArgs(op)) => {
            let mut response = recorded.clone();
            for chunk in &mut response.chunks {
                chunk.text = mutate_chunk(&chunk.text, &op);
            }
            (response, usize::MAX, Ending::Clean)
        }
        None => (recorded.clone(), usize::MAX, Ending::Clean),
    };
    let chunks: Vec<(Duration, Bytes)> = response
        .chunks
        .iter()
        .take(limit)
        .map(|chunk| {
            let scaled = Duration::from_millis(chunk.delay_ms).mul_f64(pacing.scale.max(0.0));
            let delay = scaled
                .min(Duration::from_millis(pacing.cap_ms))
                .max(Duration::from_millis(pacing.min_ms));
            (delay, Bytes::from(placeholders.reveal(&chunk.text, true)))
        })
        .collect();
    let stream = futures_util::stream::unfold(
        (chunks.into_iter(), ending, false),
        |(mut chunks, ending, done)| async move {
            if done {
                return None;
            }
            if let Some((delay, bytes)) = chunks.next() {
                tokio::time::sleep(delay).await;
                return Some((Ok::<_, std::io::Error>(bytes), (chunks, ending, false)));
            }
            match ending {
                Ending::Clean => None,
                Ending::Reset => Some((
                    Err(std::io::Error::new(
                        std::io::ErrorKind::ConnectionReset,
                        "injected reset",
                    )),
                    (chunks, ending, true),
                )),
                Ending::Stall => {
                    std::future::pending::<()>().await;
                    None
                }
            }
        },
    );
    let mut builder = Response::builder().status(response.status);
    for (name, value) in &response.headers {
        builder = builder.header(name, value);
    }
    builder
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| plain(500, "HARNESS_ERROR: bad recorded response"))
}

#[derive(Clone, Copy)]
enum Ending {
    Clean,
    Reset,
    Stall,
}

#[expect(clippy::too_many_arguments, reason = "one forwarding step, kept flat")]
async fn record(
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
        if HEADER_ALLOWLIST.contains(&name.as_str())
            && let Ok(value) = value.to_str()
        {
            kept_headers.push((name.as_str().to_owned(), value.to_owned()));
        }
    }
    let (sender, receiver) = mpsc::channel::<Result<Bytes, std::io::Error>>(64);
    let state = state.clone();
    let method = method.as_str().to_owned();
    tokio::spawn(async move {
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
            let _ = sender.send(Ok(bytes.clone())).await;
            buffer.extend_from_slice(&bytes);
            while let Some(end) = find(&buffer, b"\n\n") {
                let event: Vec<u8> = buffer.drain(..end + 2).collect();
                let now = Instant::now();
                events.push((millis(now.duration_since(last)), event));
                last = now;
            }
        }
        if !buffer.is_empty() {
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
            request: RequestRecord { method, path, key },
            response: ResponseRecord {
                status,
                headers: kept_headers,
                chunks,
            },
        });
        state
            .inflight
            .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    });
    let stream = futures_util::stream::unfold(receiver, |mut receiver| async move {
        receiver.recv().await.map(|item| (item, receiver))
    });
    builder
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| plain(502, "HARNESS_ERROR: bad upstream response"))
}

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn plain(status: u16, text: &str) -> Response<Body> {
    let mut response = Response::new(Body::from(text.to_owned()));
    *response.status_mut() =
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    response
}
