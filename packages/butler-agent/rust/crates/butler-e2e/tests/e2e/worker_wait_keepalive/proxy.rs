//! Content-free physical request timing and a strict 30-call Luna guard.
use axum::{
    Router,
    body::Body,
    extract::State,
    http::{HeaderMap, Response},
    routing::post,
};
use butler_e2e::e2e::HarnessError;
use bytes::Bytes;
use futures_util::StreamExt;
use serde_json::Value;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
#[derive(Clone)]
pub(super) struct Observation {
    pub started_ms: i64,
    pub resume: bool,
    pub delegated: bool,
    pub failed: bool,
}
pub(super) type Observations = Arc<Mutex<Vec<Observation>>>;
#[derive(Clone)]
struct Proxy {
    calls: Arc<AtomicUsize>,
    observations: Observations,
    client: reqwest::Client,
}
pub(super) async fn start(
    calls: Arc<AtomicUsize>,
) -> Result<(String, Observations, tokio::task::JoinHandle<()>), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/codex", listener.local_addr()?);
    let observations = Arc::new(Mutex::new(Vec::new()));
    let state = Proxy {
        calls,
        observations: observations.clone(),
        client: reqwest::Client::new(),
    };
    let router = Router::new()
        .route("/codex/responses", post(forward))
        .with_state(state);
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Ok((url, observations, server))
}
async fn forward(State(state): State<Proxy>, headers: HeaderMap, body: Bytes) -> Response<Body> {
    let value: Value = serde_json::from_slice(&body).unwrap();
    if value["model"] != "gpt-6-luna" || state.calls.fetch_add(1, Ordering::SeqCst) >= 30 {
        state.observations.lock().unwrap().push(Observation {
            started_ms: chrono::Utc::now().timestamp_millis(),
            resume: false,
            delegated: false,
            failed: true,
        });
        return Response::builder()
            .status(400)
            .body(Body::from("measurement call guard"))
            .unwrap();
    }
    let delegated = butler_e2e::e2e::matching::key("/codex/responses", &value, &Default::default())
        .user_request
        .starts_with("role: steward");
    let resume = !delegated
        && value["input"].as_array().is_some_and(|items| {
            items
                .iter()
                .any(|item| item["role"] == "user" && item.to_string().contains("Delegated result"))
        });
    let index = {
        let mut rows = state.observations.lock().unwrap();
        let index = rows.len();
        rows.push(Observation {
            started_ms: chrono::Utc::now().timestamp_millis(),
            resume,
            delegated,
            failed: false,
        });
        index
    };
    drop(value);
    let mut request = state
        .client
        .post("https://chatgpt.com/backend-api/codex/responses");
    for (name, value) in &headers {
        if !matches!(name.as_str(), "host" | "content-length" | "connection") {
            request = request.header(name, value);
        }
    }
    let Ok(response) = request.body(body).send().await else {
        state.observations.lock().unwrap()[index].failed = true;
        return Response::builder()
            .status(502)
            .body(Body::from("measurement transport failed"))
            .unwrap();
    };
    state.observations.lock().unwrap()[index].failed = !response.status().is_success();
    let mut builder = Response::builder().status(response.status());
    for (name, value) in response.headers() {
        if !matches!(
            name.as_str(),
            "content-length" | "transfer-encoding" | "connection" | "content-encoding"
        ) {
            builder = builder.header(name, value);
        }
    }
    let stream = response
        .bytes_stream()
        .map(|r| r.map_err(|_| std::io::Error::other("measurement stream failed")));
    builder.body(Body::from_stream(stream)).unwrap()
}
