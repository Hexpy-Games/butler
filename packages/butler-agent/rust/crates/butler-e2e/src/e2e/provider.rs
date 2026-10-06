//! Record/replay model provider: a local HTTP server the product reaches
//! through its own base-URL settings.
//!
//! - Replay: strict. Each request's match key must equal a recorded key; the
//!   n-th identical request gets the n-th recording (the last one repeats for
//!   retried identical requests). A miss answers 501 and is reported as a
//!   `HARNESS_ERROR` by [`Provider::finish`]. Background meaning extraction
//!   has an explicit synthetic stub matched against its full prompt contract;
//!   recorded extraction exchanges take precedence over that stub.
//! - Record: forwards to the live upstream, streams the reply back unchanged,
//!   and keeps a sanitized copy (one chunk per SSE event, with arrival delay).

use std::convert::Infallible;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{Request, Response};
use serde_json::Value;
use tokio::net::TcpListener;

use super::cassette::{self, Cassette, Exchange, Meta, ResponseRecord};
use super::faults::{Fault, Transform};
use super::matching;
use super::sanitize::Placeholders;
use super::{HarnessError, harness_error};

mod hold;
pub use hold::ReplyGate;
mod memory;
mod record;
mod replay;
mod synthetic;
use synthetic::Synthetic;
pub use synthetic::{Script, Timing, round_overheads};

use record::record;
use replay::{learn_echo_ids, plain, remint_ids, replay, take_fault};

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
    Synthetic(Arc<Synthetic>),
    Record {
        upstream: String,
        meta: Meta,
        client: reqwest::Client,
        out_dir: std::path::PathBuf,
        /// The extended cassette: requests it has a recording for are
        /// replayed from it instead of reaching the upstream.
        base: Option<Box<Cassette>>,
    },
}

type ChatResponder = fn(&Value) -> Option<ResponseRecord>;

type MemoryResponder = fn(&Value) -> ResponseRecord;

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
    requests: Mutex<Vec<Value>>,
    memory_requests: Mutex<Vec<Value>>,
    memory_responder: Mutex<Option<MemoryResponder>>,
    chat_responder: Mutex<Option<ChatResponder>>,
    holds: Mutex<hold::Holds>,
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

    /// A scripted model instead of a cassette (load scenarios).
    pub async fn synthetic(script: Script) -> Result<Self, HarnessError> {
        Self::serve(
            Mode::Synthetic(Synthetic::new(script)),
            Placeholders::default(),
            0,
        )
        .await
    }

    /// The clock of every exchange so far (synthetic mode only).
    pub fn timings(&self) -> Vec<Timing> {
        match &self.state.mode {
            Mode::Synthetic(synthetic) => synthetic.timings(),
            _ => Vec::new(),
        }
    }

    /// Record mode; the cassette is written to `out_dir` (default: the
    /// committed cassette root). With `base`, requests the base cassette has
    /// a recording for are replayed from it and only the rest is recorded.
    pub async fn record(
        upstream: String,
        meta: Meta,
        placeholders: Placeholders,
        out_dir: Option<std::path::PathBuf>,
        base: Option<Cassette>,
    ) -> Result<Self, HarnessError> {
        let out_dir = out_dir.unwrap_or_else(|| cassette::root().join(&meta.scenario));
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(600))
            .build()?;
        let count = base.as_ref().map_or(0, |base| base.exchanges.len());
        Self::serve(
            Mode::Record {
                upstream,
                meta,
                client,
                out_dir,
                base: base.map(Box::new),
            },
            placeholders,
            count,
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
            requests: Mutex::new(Vec::new()),
            memory_requests: Mutex::new(Vec::new()),
            memory_responder: Mutex::new(None),
            chat_responder: Mutex::new(None),
            holds: Mutex::new(hold::Holds::default()),
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

    /// Adds a fault. Record mode keeps only request-targeted argument
    /// mutations (see [`Fault::on_request`]); other faults need clean traffic.
    pub fn inject(&self, fault: Fault) -> Result<(), HarnessError> {
        if self.is_recording()
            && !(fault.request.is_some() && matches!(fault.transform, Transform::MutateToolArgs(_)))
        {
            return Ok(());
        }
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

    /// Index of the first recorded exchange whose user request contains
    /// `text` and whose tool round has `round_len` items (0 in record mode).
    pub fn exchange_for(&self, text: &str, round_len: usize) -> Result<usize, HarnessError> {
        match &self.state.mode {
            Mode::Record { .. } | Mode::Synthetic(_) => Ok(0),
            Mode::Replay(cassette) => cassette
                .exchanges
                .iter()
                .position(|exchange| {
                    exchange.request.key.user_request.contains(text)
                        && exchange.request.key.round.len() == round_len
                })
                .ok_or_else(|| harness_error(format!("no recorded exchange for {text:?}"))),
        }
    }

    pub fn clear_faults(&self) {
        lock(&self.state.faults).clear();
    }

    pub fn set_pacing(&self, pacing: Pacing) {
        *lock(&self.state.pacing) = pacing;
    }

    /// Override only the validated synthetic memory contract, for semantic E2Es.
    /// Deterministic stub model that can choose a response from the actual prompt.
    pub fn set_chat_responder(&self, responder: ChatResponder) {
        *lock(&self.state.chat_responder) = Some(responder);
    }

    pub fn set_memory_responder(&self, responder: MemoryResponder) {
        *lock(&self.state.memory_responder) = Some(responder);
    }

    /// Hold the next reply after a tool result for this explicit user request.
    pub fn hold_after_tool(&self, user: &str) -> ReplyGate {
        lock(&self.state.holds).reply(user, true)
    }

    /// Hold the next reply for a request whose persisted turn snapshot is needed.
    pub fn hold_next_reply(&self, user: &str) -> ReplyGate {
        lock(&self.state.holds).reply(user, false)
    }

    pub fn add_placeholder(&self, name: &str, value: impl Into<String>) {
        lock(&self.state.placeholders).add(name, value);
    }

    /// Unmatched request keys so far (strict replay misses).
    pub fn misses(&self) -> Vec<String> {
        lock(&self.state.misses).clone()
    }

    /// Number of interactive provider requests answered so far.
    pub fn served(&self) -> u32 {
        *lock(&self.state.served)
    }

    /// Interactive request snapshots for public-path E2E assertions.
    /// Background extraction is available through `memory_requests`.
    pub fn requests(&self) -> Vec<Value> {
        lock(&self.state.requests).clone()
    }

    /// Background meaning calls have their own strict stub contract and trace.
    pub fn memory_requests(&self) -> Vec<Value> {
        lock(&self.state.memory_requests).clone()
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
        if let Mode::Record { meta, out_dir, .. } = &self.state.mode {
            let exchanges = lock(&self.state.recorded).clone();
            let dir = out_dir.clone();
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

/// Serves the recording for `key` from `cassette` (the n-th identical request
/// gets the n-th recording; the last one repeats with re-minted ids), or
/// `None` when the cassette has no recording for it.
fn replay_recorded(
    state: &State,
    cassette: &Cassette,
    key: &cassette::MatchKey,
) -> Option<Response<Body>> {
    let candidates: Vec<usize> = cassette
        .exchanges
        .iter()
        .enumerate()
        .filter(|(_, exchange)| exchange.request.key == *key)
        .map(|(index, _)| index)
        .collect();
    let first = *candidates.first()?;
    let hit = {
        let mut hits = lock(&state.hits);
        let seen = hits[first];
        hits[first] += 1;
        seen as usize
    };
    let index = candidates[hit.min(candidates.len() - 1)];
    let fault = take_fault(state, Some(index), key);
    let reserve = (hit + 1).saturating_sub(candidates.len());
    let mut response = cassette.exchanges[index].response.clone();
    if reserve > 0 {
        remint_ids(&mut response, reserve);
    }
    Some(replay(state, &response, fault))
}

async fn handle(state: Arc<State>, request: Request<Body>) -> Response<Body> {
    let (parts, body) = request.into_parts();
    let path = parts.uri.path().to_owned();
    let bytes = axum::body::to_bytes(body, 64 * 1024 * 1024)
        .await
        .unwrap_or_default();
    let arrived = Instant::now();
    let json: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let memory = memory::matches(&json);
    if let Mode::Synthetic(synthetic) = &state.mode {
        if memory {
            return replay(&state, &memory::response(), None);
        }
        let response = synthetic.respond(&json, bytes.len(), arrived);
        lock(&state.requests).push(json);
        return response;
    }
    if memory && matches!(&state.mode, Mode::Replay(_)) {
        lock(&state.memory_requests).push(json.clone());
    } else {
        *lock(&state.served) += 1;
    }
    if !memory && matches!(&state.mode, Mode::Replay(_)) {
        lock(&state.requests).push(json.clone());
    }
    learn_echo_ids(&state, &String::from_utf8_lossy(&bytes));
    let key = matching::key(&path, &json, &lock(&state.placeholders));
    let hold = lock(&state.holds).take(&key);
    if let Some(hold) = hold {
        let _ = hold.await;
    }
    match &state.mode {
        Mode::Synthetic(synthetic) => synthetic.respond(&json, bytes.len(), arrived),
        Mode::Replay(cassette) => {
            if !memory
                && let Some(response) =
                    lock(&state.chat_responder).and_then(|respond| respond(&json))
            {
                return replay(&state, &response, None);
            }
            if let Some(response) = replay_recorded(&state, cassette, &key) {
                return response;
            }
            if memory {
                let response = lock(&state.memory_responder)
                    .map_or_else(memory::response, |responder| responder(&json));
                return replay(&state, &response, None);
            }
            // A declared stall may target a request whose live round was
            // cut off by a crash during recording: hold it open, answer nothing.
            if let Some((_, Transform::StallAfter(0))) = take_fault(&state, None, &key) {
                return replay(
                    &state,
                    &ResponseRecord {
                        status: 200,
                        headers: Vec::new(),
                        chunks: Vec::new(),
                    },
                    Some((usize::MAX, Transform::StallAfter(0))),
                );
            }
            lock(&state.misses).push(serde_json::to_string(&key).unwrap_or_default());
            plain(501, "HARNESS_ERROR: no recording matches this request")
        }
        Mode::Record {
            base: Some(base), ..
        } if base
            .exchanges
            .iter()
            .any(|exchange| exchange.request.key == key) =>
        {
            replay_recorded(&state, base, &key)
                .unwrap_or_else(|| plain(501, "HARNESS_ERROR: base recording lost"))
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
