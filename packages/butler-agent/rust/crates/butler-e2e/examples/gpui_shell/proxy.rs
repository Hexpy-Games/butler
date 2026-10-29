//! Harness-owned loopback proxy: interrupt SSE and refuse reconnects for a timed burst.
use axum::{
    body::{Body, to_bytes},
    extract::State,
    http::{Request, StatusCode},
    response::Response,
};
use futures_util::StreamExt as _;
use std::{
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

#[derive(Clone)]
struct Relay {
    upstream: String,
    http: butler_log::http::Client,
    until: Arc<Mutex<Instant>>,
    interrupt: tokio::sync::watch::Sender<u64>,
    refused: Arc<AtomicUsize>,
}
pub(super) struct Proxy {
    relay: Relay,
    endpoint: String,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Proxy {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Proxy {
    pub(super) async fn start(upstream: String) -> anyhow::Result<Self> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let endpoint = format!("http://{}", listener.local_addr()?);
        let relay = Relay {
            upstream,
            http: butler_log::http::loopback().no_proxy().build()?,
            until: Arc::new(Mutex::new(Instant::now())),
            interrupt: tokio::sync::watch::channel(0).0,
            refused: Arc::default(),
        };
        let app = axum::Router::new()
            .fallback(forward)
            .with_state(relay.clone());
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Ok(Self {
            relay,
            endpoint,
            task,
        })
    }
    pub(super) async fn attach(&self, data: &Path) -> anyhow::Result<()> {
        let path = data.join("state/butler-agent-native-service.json");
        let mut raw: serde_json::Value = serde_json::from_slice(&tokio::fs::read(&path).await?)?;
        raw["app_endpoint"] = self.endpoint.clone().into();
        tokio::fs::write(path, serde_json::to_vec(&raw)?).await?;
        Ok(())
    }
    pub(super) fn burst(&self) -> anyhow::Result<()> {
        *self
            .relay
            .until
            .lock()
            .map_err(|_| anyhow::anyhow!("burst lock"))? = Instant::now() + Duration::from_secs(3);
        self.relay
            .interrupt
            .send_modify(|generation| *generation += 1);
        Ok(())
    }
    pub(super) fn refused(&self) -> usize {
        self.relay.refused.load(Ordering::SeqCst)
    }
}
async fn forward(
    State(relay): State<Relay>,
    request: Request<Body>,
) -> Result<Response, StatusCode> {
    let live = request.uri().path() == "/events/live";
    let mut interrupt = relay.interrupt.subscribe();
    if live
        && Instant::now()
            < *relay
                .until
                .lock()
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    {
        relay.refused.fetch_add(1, Ordering::SeqCst);
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    let (mut parts, body) = request.into_parts();
    // Let the upstream client set its own Host; the gateway checks its exact authority.
    parts.headers.remove(axum::http::header::HOST);
    let bytes = to_bytes(body, 8 * 1024 * 1024)
        .await
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    let response = relay
        .http
        .request(parts.method, format!("{}{}", relay.upstream, parts.uri))
        .phase(butler_log::http::Phase::current().sensitive())
        .headers(parts.headers)
        .body(bytes)
        .send()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    let mut output = Response::builder().status(response.status());
    for (key, value) in response.headers() {
        output = output.header(key, value);
    }
    let stream = response.bytes_stream().take_until(async move {
        if live {
            let _ = interrupt.changed().await;
        } else {
            std::future::pending::<()>().await;
        }
    });
    output
        .body(Body::from_stream(stream))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}
