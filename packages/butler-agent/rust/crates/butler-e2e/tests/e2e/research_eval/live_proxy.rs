//! Local byte-preserving model forwarder and counted, refusing egress sink.
use super::{fixture::Task, live_usage};
use axum::{
    Router,
    body::{Body, Bytes},
    extract::{Query, Request, State},
    response::Response,
    routing::{get, post},
};
use butler_e2e::e2e::{HarnessError, config::LiveProvider};
use futures_util::stream;
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
    time::Instant,
};
use tokio::sync::{Notify, mpsc, oneshot};

#[derive(Default)]
pub(super) struct Spend {
    pub total: f64,
    pub judge: f64,
    pub max: f64,
}
impl Spend {
    pub(super) fn stopped(&self) -> bool {
        self.total > self.max
    }
}

pub(super) struct Traffic {
    pub budget: super::live_limits::TaskBudget,
    pub offline_misses: Vec<String>,
    pub requests: Vec<Value>,
    pub received: BTreeSet<usize>,
    pub refused_hosts: Vec<String>,
    pub last_request: Instant,
    pub stopped: bool,
    pub usage_failed: bool,
    pub rejected_model_requests: usize,
    pub pending: usize,
    pub changed: Arc<Notify>,
    pub nonbrowser_page_outputs: usize,
    pub browser_page_outputs: usize,
    pub host_ready: bool,
    pub snapshot_reads: usize,
    pub host_reader_replies: usize,
    pub unknown_host_ops: usize,
    pub host_errors: Vec<String>,
    pub host_ops: std::collections::BTreeMap<String, usize>,
}
impl Default for Traffic {
    fn default() -> Self {
        Self {
            budget: Default::default(),
            offline_misses: Vec::new(),
            requests: Vec::new(),
            received: BTreeSet::new(),
            refused_hosts: Vec::new(),
            last_request: Instant::now(),
            stopped: false,
            usage_failed: false,
            rejected_model_requests: 0,
            pending: 0,
            changed: Arc::new(Notify::new()),
            nonbrowser_page_outputs: 0,
            browser_page_outputs: 0,
            host_ready: false,
            snapshot_reads: 0,
            host_reader_replies: 0,
            unknown_host_ops: 0,
            host_errors: Vec::new(),
            host_ops: Default::default(),
        }
    }
}
type Pumps = Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>>;

struct Head {
    status: http::StatusCode,
    content_type: Option<http::HeaderValue>,
    encoding: Option<http::HeaderValue>,
}

#[derive(Clone)]
struct Forward {
    upstream: String,
    expected_model: String,
    pumps: Pumps,
    client: reqwest::Client,
    traffic: Arc<Mutex<Traffic>>,
    spend: Arc<Mutex<Spend>>,
    task: Arc<Task>,
}
pub(super) struct Proxy {
    pub base: String,
    pub sink: String,
    pub traffic: Arc<Mutex<Traffic>>,
    servers: Vec<tokio::task::JoinHandle<()>>,
    pumps: Pumps,
}
impl Proxy {
    pub(super) async fn start(
        provider: &LiveProvider,
        task: Arc<Task>,
        spend: Arc<Mutex<Spend>>,
    ) -> Result<Self, HarnessError> {
        let budget = super::live_limits::TaskBudget::from_env()?;
        let proxy = Self::with_upstream(
            provider.upstream_default().expect("upstream").into(),
            task,
            spend,
            provider
                .choice
                .model
                .split_once('/')
                .expect("provider/model")
                .1,
        )
        .await?;
        proxy.traffic.lock().unwrap().budget = budget;
        Ok(proxy)
    }
    pub(super) async fn with_upstream(
        upstream: String,
        task: Arc<Task>,
        spend: Arc<Mutex<Spend>>,
        expected_model: &str,
    ) -> Result<Self, HarnessError> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}", listener.local_addr()?);
        let sink_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let sink = format!("http://{}", sink_listener.local_addr()?);
        let traffic = Arc::new(Mutex::new(Traffic::default()));
        let pumps = Arc::new(Mutex::new(Vec::new()));
        let state = Forward {
            upstream,
            expected_model: expected_model.into(),
            pumps: pumps.clone(),
            client: reqwest::Client::builder()
                .no_proxy()
                .no_gzip()
                .no_brotli()
                .no_deflate()
                .retry(reqwest::retry::never())
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            traffic: traffic.clone(),
            spend,
            task,
        };
        let app = Router::new()
            .route("/chat/completions", post(forward))
            .route("/search", get(search))
            .route(
                "/host-events",
                post(super::live_metrics::host_events).with_state(traffic.clone()),
            )
            .layer(axum::extract::DefaultBodyLimit::disable())
            .with_state(state);
        let sink_app = Router::new().fallback(refuse).with_state(traffic.clone());
        let servers = vec![
            tokio::spawn(async move {
                let _ = axum::serve(listener, app).await;
            }),
            tokio::spawn(async move {
                let _ = axum::serve(sink_listener, sink_app).await;
            }),
        ];
        Ok(Self {
            base,
            sink,
            traffic,
            servers,
            pumps,
        })
    }
}
impl Proxy {
    /// Finish metering requests already sent, even if the agent closed its stream.
    pub(super) async fn settle(&self) -> bool {
        let changed = self.traffic.lock().unwrap().changed.clone();
        loop {
            let signaled = changed.notified();
            let remaining = {
                let traffic = self.traffic.lock().unwrap();
                if traffic.pending == 0 {
                    return true;
                }
                std::time::Duration::from_secs(300).saturating_sub(traffic.last_request.elapsed())
            };
            if tokio::time::timeout(remaining, signaled).await.is_err() {
                return false;
            }
        }
    }
}
impl Drop for Proxy {
    fn drop(&mut self) {
        for server in &self.servers {
            server.abort();
        }
        for pump in self.pumps.lock().unwrap().drain(..) {
            pump.abort();
        }
    }
}
async fn refuse(State(traffic): State<Arc<Mutex<Traffic>>>, request: Request) -> Response {
    let host = request
        .uri()
        .host()
        .or_else(|| request.headers().get("host").and_then(|h| h.to_str().ok()))
        .unwrap_or("unknown");
    // Authority only: never retain paths, query strings, or headers.
    traffic.lock().unwrap().refused_hosts.push(host.to_owned());
    Response::builder()
        .status(403)
        .body(Body::from("offline evaluation"))
        .unwrap()
}
async fn forward(State(state): State<Forward>, request: Request) -> Response {
    if state.spend.lock().unwrap().stopped() {
        state.traffic.lock().unwrap().stopped = true;
        return Response::builder()
            .status(402)
            .body(Body::from("spend guard"))
            .unwrap();
    }
    if state.traffic.lock().unwrap().usage_failed {
        return failure();
    }
    let judge = request.headers().contains_key("x-research-judge");
    let authorization = request.headers().get("authorization").cloned();
    let Ok(bytes) = axum::body::to_bytes(request.into_body(), usize::MAX).await else {
        return failure();
    };
    let body: Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return failure(),
    };
    if body["model"].as_str() != Some(state.expected_model.as_str()) {
        state.traffic.lock().unwrap().rejected_model_requests += 1;
        return Response::builder()
            .status(400)
            .body(Body::from("unauthorized model"))
            .unwrap();
    }
    let index = {
        let mut traffic = state.traffic.lock().unwrap();
        if !judge && traffic.budget.runaway {
            return Response::builder()
                .status(402)
                .body(Body::from("task runaway cap"))
                .unwrap();
        }
        traffic.last_request = Instant::now();
        if !judge {
            traffic.budget.admit();
            traffic
                .received
                .extend(live_usage::received(&body, &state.task));
            for page in super::policy::outputs(&live_usage::canonical(&body)) {
                if page["source_url"].is_string()
                    && page["ok"] == true
                    && page["reader"].is_string()
                {
                    if matches!(
                        page["reader"].as_str(),
                        Some("butler-browser" | "butler-browser-tab")
                    ) {
                        traffic.browser_page_outputs += 1;
                    } else {
                        traffic.nonbrowser_page_outputs += 1;
                    }
                }
            }
        }
        let index = traffic.requests.len();
        traffic.pending += 1;
        traffic.requests.push(
            json!({"lane":if judge {"judge"} else {live_usage::lane(&body)},
            "round":index+1,"usage":null,"http_status":null}),
        );
        index
    };
    let (head_tx, head_rx) = oneshot::channel();
    let (body_tx, body_rx) = mpsc::channel(4);
    let pumps = state.pumps.clone();
    pumps.lock().unwrap().push(tokio::spawn(pump(
        state,
        index,
        judge,
        bytes,
        authorization,
        head_tx,
        body_tx,
    )));
    let Ok(head) = head_rx.await else {
        return failure();
    };
    let stream = stream::unfold(body_rx, |mut rx| async move {
        rx.recv().await.map(|bytes| (bytes, rx))
    });
    let mut builder = Response::builder().status(head.status);
    if let Some(value) = head.content_type {
        builder = builder.header("content-type", value);
    }
    if let Some(value) = head.encoding {
        builder = builder.header("content-encoding", value);
    }
    builder.body(Body::from_stream(stream)).unwrap()
}
async fn pump(
    state: Forward,
    index: usize,
    judge: bool,
    bytes: Bytes,
    authorization: Option<http::HeaderValue>,
    head: oneshot::Sender<Head>,
    body: mpsc::Sender<Result<Bytes, std::io::Error>>,
) {
    let mut observer = Observer {
        state: state.clone(),
        index,
        judge,
        buffer: Vec::new(),
        error_body: None,
        recorded: false,
        tool_names: Default::default(),
    };
    let mut outgoing = state
        .client
        .post(format!(
            "{}/chat/completions",
            state.upstream.trim_end_matches('/')
        ))
        .header("content-type", "application/json")
        .header("accept-encoding", "identity")
        .body(bytes.clone());
    if let Some(auth) = authorization {
        outgoing = outgoing.header("authorization", auth);
    }
    let Ok(mut response) = outgoing.send().await else {
        return;
    };
    if !response.status().is_success() {
        observer.error_body = Some(Vec::new());
        state.traffic.lock().unwrap().requests[index]["rejected_request"] =
            serde_json::from_slice(&bytes).unwrap();
    }
    state.traffic.lock().unwrap().requests[index]["http_status"] =
        json!(response.status().as_u16());
    // https://api-docs.deepseek.com/quick_start/error_codes/
    if matches!(response.status().as_u16(), 400 | 401 | 402 | 422 | 429) {
        let mut traffic = state.traffic.lock().unwrap();
        traffic.requests[index]["rejected_before_inference"] = json!(true);
        traffic.requests[index]["usd"] = json!(0.0);
        traffic.requests[index]["sol_usd"] = json!(0.0);
    }
    let _ = head.send(Head {
        status: response.status(),
        content_type: response.headers().get("content-type").cloned(),
        encoding: response.headers().get("content-encoding").cloned(),
    });
    loop {
        match response.chunk().await {
            Ok(Some(bytes)) => {
                observer.feed(&bytes);
                // A disconnected consumer must not discard the provider's final usage.
                let _ = body.send(Ok(bytes)).await;
            }
            Ok(None) => {
                observer.finish();
                return;
            }
            Err(_) => {
                let _ = body
                    .send(Err(std::io::Error::other("upstream stream failed")))
                    .await;
                return;
            }
        }
    }
}
fn failure() -> Response {
    Response::builder()
        .status(502)
        .body(Body::from("model forwarding failed"))
        .unwrap()
}
struct Observer {
    state: Forward,
    index: usize,
    judge: bool,
    buffer: Vec<u8>,
    error_body: Option<Vec<u8>>,
    recorded: bool,
    tool_names: std::collections::BTreeMap<usize, String>,
}
impl Observer {
    fn feed(&mut self, bytes: &[u8]) {
        if let Some(body) = &mut self.error_body {
            body.extend_from_slice(bytes);
        }
        self.buffer.extend_from_slice(bytes);
        // Parse complete SSE lines; preserve the original bytes for the client.
        while self.buffer.starts_with(b"data:")
            || self.buffer.starts_with(b":")
            || self.buffer.starts_with(b"\n")
            || self.buffer.starts_with(b"\r")
        {
            let Some(end) = self.buffer.iter().position(|b| *b == b'\n') else {
                break;
            };
            let line = self.buffer.drain(..=end).collect::<Vec<_>>();
            if let Some(data) = line.strip_prefix(b"data:") {
                self.observe(data);
            }
        }
    }
    fn finish(&mut self) {
        if let Some(body) = self.error_body.take() {
            self.state.traffic.lock().unwrap().requests[self.index]["provider_error_body"] =
                json!(String::from_utf8_lossy(&body));
        }
        let tail = std::mem::take(&mut self.buffer);
        self.observe(tail.strip_prefix(b"data:").unwrap_or(&tail));
    }
    fn observe(&mut self, bytes: &[u8]) {
        let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
            return;
        };
        if !self.judge {
            super::live_limits::collect_tools(&value, &mut self.tool_names);
        }
        if value["error"].is_object() {
            self.state.traffic.lock().unwrap().requests[self.index]["provider_error"] =
                value["error"].clone();
        }
        let usage = &value["usage"];
        if self.recorded || !live_usage::valid(usage) {
            return;
        }
        self.recorded = true;
        let usd = live_usage::price("deepseek/deepseek-flash", usage);
        let sol = live_usage::price("openai/gpt-6.1-sol", usage);
        let mut spend = self.state.spend.lock().unwrap();
        spend.total += usd;
        if self.judge {
            spend.judge += usd;
        }
        let mut traffic = self.state.traffic.lock().unwrap();
        if !self.judge {
            traffic.budget.record_cost(usd);
        }
        traffic.requests[self.index]["usage"] = usage.clone();
        traffic.requests[self.index]["usd"] = json!(usd);
        traffic.requests[self.index]["sol_usd"] = json!(sol);
        traffic.stopped |= spend.stopped();
    }
}

async fn search(
    State(state): State<Forward>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> axum::Json<Value> {
    axum::Json(super::fixture::search_response(
        &state.task,
        query.get("q").map(String::as_str),
        true,
    ))
}

impl Drop for Observer {
    fn drop(&mut self) {
        let mut traffic = self.state.traffic.lock().unwrap();
        for name in self.tool_names.values().filter(|n| !n.is_empty()) {
            *traffic.budget.tools.entry(name.clone()).or_default() += 1;
        }
        traffic.usage_failed |= !live_usage::accounted(&traffic.requests[self.index]);
        traffic.requests[self.index]["finished"] = json!(true);
        traffic.pending -= 1;
        traffic.changed.notify_one();
    }
}
