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
    pub requests: Vec<Value>,
    pub received: BTreeSet<usize>,
    pub refused_hosts: Vec<String>,
    pub last_request: Instant,
    pub stopped: bool,
    pub usage_failed: bool,
    pub nonbrowser_page_outputs: usize,
    pub browser_page_outputs: usize,
}
impl Default for Traffic {
    fn default() -> Self {
        Self {
            requests: Vec::new(),
            received: BTreeSet::new(),
            refused_hosts: Vec::new(),
            last_request: Instant::now(),
            stopped: false,
            usage_failed: false,
            nonbrowser_page_outputs: 0,
            browser_page_outputs: 0,
        }
    }
}
#[derive(Clone)]
struct Forward {
    upstream: String,
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
}
impl Proxy {
    pub(super) async fn start(
        provider: &LiveProvider,
        task: Arc<Task>,
        spend: Arc<Mutex<Spend>>,
    ) -> Result<Self, HarnessError> {
        Self::with_upstream(
            provider.upstream_default().expect("upstream").into(),
            task,
            spend,
        )
        .await
    }
    pub(super) async fn with_upstream(
        upstream: String,
        task: Arc<Task>,
        spend: Arc<Mutex<Spend>>,
    ) -> Result<Self, HarnessError> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}", listener.local_addr()?);
        let sink_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let sink = format!("http://{}", sink_listener.local_addr()?);
        let traffic = Arc::new(Mutex::new(Traffic::default()));
        let state = Forward {
            upstream,
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
        })
    }
}
impl Drop for Proxy {
    fn drop(&mut self) {
        for server in &self.servers {
            server.abort();
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
    let index = {
        let mut traffic = state.traffic.lock().unwrap();
        traffic.last_request = Instant::now();
        if !judge {
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
        traffic.requests.push(
            json!({"lane":if judge {"judge"} else {live_usage::lane(&body)},
            "usage":null,"http_status":null}),
        );
        index
    };
    relay(state, index, judge, bytes, authorization).await
}
async fn relay(
    state: Forward,
    index: usize,
    judge: bool,
    bytes: Bytes,
    authorization: Option<http::HeaderValue>,
) -> Response {
    let mut outgoing = state
        .client
        .post(format!(
            "{}/chat/completions",
            state.upstream.trim_end_matches('/')
        ))
        .header("content-type", "application/json")
        .header("accept-encoding", "identity")
        .body(bytes);
    if let Some(auth) = authorization {
        outgoing = outgoing.header("authorization", auth);
    }
    let Ok(response) = outgoing.send().await else {
        return failure();
    };
    let status = response.status();
    state.traffic.lock().unwrap().requests[index]["http_status"] = json!(status.as_u16());
    let content_type = response.headers().get("content-type").cloned();
    let encoding = response.headers().get("content-encoding").cloned();
    let observer = Observer {
        state,
        index,
        judge,
        buffer: Vec::new(),
        recorded: false,
        failed: false,
    };
    let stream = stream::unfold(
        (response, observer),
        |(mut response, mut observer)| async move {
            if observer.failed {
                return None;
            }
            match response.chunk().await {
                Ok(Some(bytes)) => {
                    observer.feed(&bytes);
                    Some((Ok::<Bytes, std::io::Error>(bytes), (response, observer)))
                }
                Ok(None) => {
                    observer.finish();
                    None
                }
                Err(_) => {
                    observer.failed = true;
                    Some((
                        Err(std::io::Error::other("upstream stream failed")),
                        (response, observer),
                    ))
                }
            }
        },
    );
    let mut builder = Response::builder().status(status);
    if let Some(value) = content_type {
        builder = builder.header("content-type", value);
    }
    if let Some(value) = encoding {
        builder = builder.header("content-encoding", value);
    }
    builder.body(Body::from_stream(stream)).unwrap()
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
    recorded: bool,
    failed: bool,
}
impl Observer {
    fn feed(&mut self, bytes: &[u8]) {
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
        let tail = std::mem::take(&mut self.buffer);
        self.observe(tail.strip_prefix(b"data:").unwrap_or(&tail));
    }
    fn observe(&mut self, bytes: &[u8]) {
        let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
            return;
        };
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
        if !self.recorded {
            self.state.traffic.lock().unwrap().usage_failed = true;
        }
    }
}
