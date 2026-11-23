//! Harness-owned loopback proxy for gateway route overrides and SSE interruptions.
use axum::{
    body::{Body, to_bytes},
    extract::State,
    http::{Request, StatusCode},
    response::Response,
};
use futures_util::StreamExt as _;
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use super::{HarnessError, harness_error};

type RouteOverrides = HashMap<(String, String), VecDeque<(u16, Value)>>;

#[derive(Clone)]
struct Relay {
    upstream: String,
    http: butler_log::http::Client,
    until: Arc<Mutex<Instant>>,
    interrupt: tokio::sync::watch::Sender<u64>,
    refused: Arc<AtomicUsize>,
    overrides: Arc<Mutex<RouteOverrides>>,
    seen: Arc<Mutex<Vec<(String, Value)>>>,
}
pub struct GatewayProxy {
    relay: Relay,
    endpoint: String,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for GatewayProxy {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl GatewayProxy {
    pub async fn start(upstream: String) -> Result<Self, HarnessError> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let endpoint = format!("http://{}", listener.local_addr()?);
        let relay = Relay {
            upstream,
            http: butler_log::http::loopback().no_proxy().build()?,
            until: Arc::new(Mutex::new(Instant::now())),
            interrupt: tokio::sync::watch::channel(0).0,
            refused: Arc::default(),
            overrides: Arc::default(),
            seen: Arc::default(),
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
    pub async fn attach(&self, data: &Path) -> Result<(), HarnessError> {
        let path = data.join("state/butler-agent-native-service.json");
        let mut raw: serde_json::Value = serde_json::from_slice(&tokio::fs::read(&path).await?)?;
        raw["app_endpoint"] = self.endpoint.clone().into();
        tokio::fs::write(path, serde_json::to_vec(&raw)?).await?;
        Ok(())
    }
    pub fn burst(&self) -> Result<(), HarnessError> {
        *self
            .relay
            .until
            .lock()
            .map_err(|_| harness_error("burst lock"))? = Instant::now() + Duration::from_secs(3);
        self.relay
            .interrupt
            .send_modify(|generation| *generation += 1);
        Ok(())
    }
    pub fn refused(&self) -> usize {
        self.relay.refused.load(Ordering::SeqCst)
    }

    pub fn override_route(&self, method: &str, path: &str, status: u16, body: Value) {
        self.relay
            .overrides
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry((method.to_owned(), path.to_owned()))
            .or_default()
            .push_back((status, body));
    }

    pub fn requests(&self, path: &str) -> Vec<Value> {
        self.relay
            .seen
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .filter(|(seen, _)| seen == path)
            .map(|(_, body)| body.clone())
            .collect()
    }
}
async fn forward(
    State(relay): State<Relay>,
    request: Request<Body>,
) -> Result<Response, StatusCode> {
    let live = request.uri().path() == "/events/live";
    let mut interrupt = relay.interrupt.subscribe();
    let (mut parts, body) = request.into_parts();
    // Let the upstream client set its own Host; the gateway checks its exact authority.
    parts.headers.remove(axum::http::header::HOST);
    let bytes = to_bytes(body, 8 * 1024 * 1024)
        .await
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    let path = parts.uri.path().to_owned();
    relay
        .seen
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .push((
            path.clone(),
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        ));
    let response_override = relay
        .overrides
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .get_mut(&(parts.method.to_string(), path))
        .and_then(|queue| {
            if queue.len() > 1 {
                queue.pop_front()
            } else {
                queue.front().cloned()
            }
        });
    if let Some((status, body)) = response_override {
        let body = serde_json::to_vec(&body).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        return Response::builder()
            .status(status)
            .header(axum::http::header::CONTENT_TYPE, "application/json")
            .body(Body::from(body))
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR);
    }
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
