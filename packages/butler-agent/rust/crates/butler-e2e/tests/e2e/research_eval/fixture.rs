use super::policy::Policy;
use axum::{
    Json, Router,
    extract::{Query, State},
    response::IntoResponse,
    routing::{get, post},
};
use butler_e2e::e2e::HarnessError;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
};

pub(super) struct Task {
    pub spec: Value,
    pub pages: HashMap<String, (String, String)>,
}
impl Task {
    pub(super) fn load(directory: &Path) -> Result<Self, HarnessError> {
        let spec: Value = serde_json::from_slice(&std::fs::read(directory.join("task.json"))?)?;
        let mut pages = HashMap::new();
        for page in spec["pages"].as_array().expect("pages") {
            let relative = Path::new(page["file"].as_str().unwrap());
            assert!(
                relative
                    .components()
                    .all(|c| matches!(c, std::path::Component::Normal(_))),
                "snapshot must be relative"
            );
            let html = std::fs::read_to_string(directory.join(relative))?;
            pages.insert(
                page["url"].as_str().unwrap().into(),
                (page["title"].as_str().unwrap_or_default().into(), html),
            );
        }
        Ok(Self { spec, pages })
    }
}
pub(super) struct Fixture {
    pub base: String,
    pub state: Arc<Mutex<Policy>>,
    server: tokio::task::JoinHandle<()>,
}
impl Fixture {
    pub(super) async fn start(task: Arc<Task>) -> Result<Self, HarnessError> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}", listener.local_addr()?);
        let state = Arc::new(Mutex::new(Policy::new(task)));
        let app = Router::new()
            .route("/v1/responses", post(reply))
            .route_layer(axum::middleware::from_fn(
                butler_e2e::e2e::chatgpt_wire::validate,
            ))
            .route("/search", get(search))
            .with_state(state.clone());
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Ok(Self {
            base,
            state,
            server,
        })
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}
async fn reply(
    State(state): State<Arc<Mutex<Policy>>>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let items = state.lock().unwrap().reply(&body);
    let wire = crate::steward_presentation::stub::wire_items(&items).replace(
        "gpt-6-luna",
        body["model"].as_str().unwrap_or("gpt-6.1-sol"),
    );
    ([("content-type", "text/event-stream")], wire)
}
async fn search(
    State(state): State<Arc<Mutex<Policy>>>,
    Query(query): Query<HashMap<String, String>>,
) -> Json<Value> {
    let state = state.lock().unwrap();
    let results = state.task.spec["searches"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|s| s["query"].as_str() == query.get("q").map(String::as_str))
        .map(|s| s["results"].clone())
        .unwrap_or(json!([]));
    Json(json!({"web":{"results":results}}))
}
