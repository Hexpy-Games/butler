use axum::{
    Router,
    body::Body,
    extract::{Path as UrlPath, State},
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::get,
};
use butler_e2e::e2e::{HarnessError, gateway::Gateway};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant, SystemTime},
};

#[derive(Clone)]
pub(crate) struct Server {
    pub(crate) primary: Arc<AtomicUsize>,
    pub(crate) mirror: Arc<AtomicUsize>,
    pub(crate) ranges: Arc<AtomicUsize>,
    pub(crate) primary_ok: Arc<AtomicBool>,
    pub(crate) fail_all: Arc<AtomicBool>,
    pub(crate) corrupt: Arc<AtomicBool>,
    pub(crate) pause: Arc<AtomicBool>,
    pub(crate) offsets: Arc<Mutex<Vec<usize>>>,
    address: String,
}
const BYTES: usize = 256 * 1024;
const FILES: [&str; 4] = [
    "tokenizer.json",
    "tokenizer_config.json",
    "config.json",
    "onnx/model_quantized.onnx",
];
impl Server {
    pub(crate) async fn start() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let server = Self {
            primary: Arc::default(),
            mirror: Arc::default(),
            ranges: Arc::default(),
            primary_ok: Arc::default(),
            fail_all: Arc::default(),
            corrupt: Arc::default(),
            pause: Arc::default(),
            offsets: Arc::default(),
            address: format!("http://{}", listener.local_addr().unwrap()),
        };
        let app = Router::new()
            .route("/{source}/{*file}", get(asset))
            .with_state(server.clone());
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        server
    }
    pub(crate) fn total(&self) -> u64 {
        (BYTES * 4) as u64
    }
    pub(crate) fn requests(&self) -> usize {
        self.primary.load(Ordering::SeqCst) + self.mirror.load(Ordering::SeqCst)
    }
    pub(crate) fn manifest(&self) -> String {
        let hash = format!("{:x}", Sha256::digest(vec![42; BYTES]));
        json!({"assets": FILES.map(|relative| json!({"relative":relative,"bytes":BYTES,"sha256":hash})),
            "sources":[format!("{}/primary", self.address), format!("{}/mirror", self.address)]}).to_string()
    }
}
async fn asset(
    State(server): State<Server>,
    UrlPath((source, _file)): UrlPath<(String, String)>,
    headers: HeaderMap,
) -> Response {
    if source == "primary" {
        server.primary.fetch_add(1, Ordering::SeqCst);
        if !server.primary_ok.load(Ordering::SeqCst) {
            return Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Body::empty())
                .unwrap();
        }
    }
    if source != "primary" {
        server.mirror.fetch_add(1, Ordering::SeqCst);
    }
    if server.fail_all.load(Ordering::SeqCst) {
        return Response::builder().status(503).body(Body::empty()).unwrap();
    }
    let start = headers
        .get("range")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("bytes="))
        .and_then(|v| v.strip_suffix('-'))
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0);
    if start > 0 {
        server.ranges.fetch_add(1, Ordering::SeqCst);
        server.offsets.lock().unwrap().push(start);
    }
    let value = if server.corrupt.load(Ordering::SeqCst) {
        43
    } else {
        42
    };
    let pause = server.pause.clone();
    let stream = futures_util::stream::unfold(start, move |position| {
        let pause = pause.clone();
        async move {
            if position >= BYTES {
                return None;
            }
            while position >= 64 * 1024 && pause.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
            let count = (BYTES - position).min(8192);
            Some((
                Ok::<_, std::io::Error>(bytes::Bytes::from(vec![value; count])),
                position + count,
            ))
        }
    });
    let mut reply = Response::builder()
        .status(if start > 0 { 206 } else { 200 })
        .header("content-length", BYTES - start);
    if start > 0 {
        reply = reply.header(
            "content-range",
            format!("bytes {start}-{}/{}", BYTES - 1, BYTES),
        );
    }
    reply.body(Body::from_stream(stream)).unwrap()
}
pub(crate) async fn model_until(gw: &Gateway, state: &str) -> Result<Value, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let reply = gw.get("/setup/readiness").await?;
        let model = reply.data()["memory_model"].clone();
        if model["state"] == state
            && (state != "downloading" || model["bytes_done"].as_u64().unwrap_or(0) > 0)
        {
            return Ok(model);
        }
        assert!(
            Instant::now() < deadline,
            "model did not reach {state}: {model}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
pub(crate) fn snapshot(root: &Path) -> Result<Vec<(String, u64, SystemTime)>, std::io::Error> {
    let mut result = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let meta = entry.metadata()?;
        result.push((
            entry.path().display().to_string(),
            meta.len(),
            meta.modified()?,
        ));
        if meta.is_dir() {
            result.extend(snapshot(&entry.path())?);
        }
    }
    result.sort();
    Ok(result)
}
