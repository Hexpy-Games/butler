//! Stub-only Butler account service.
use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
};

use axum::{
    Json, Router,
    body::Bytes,
    extract::State as AxumState,
    http::{HeaderMap, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use tokio::task::JoinHandle;

use super::HarnessError;

const PAGE_ID: &str = "k7m2q9xd4b3hn";
const PAGE_URL: &str = "https://pages.test/p/k7m2q9xd4b3hn/";

struct State {
    seen: Mutex<Vec<String>>,
    plan: Mutex<String>,
    blobs: Mutex<BTreeSet<String>>,
    page: Mutex<Option<(String, u64)>>,
}

pub struct FakeButlerCloud {
    pub url: String,
    state: Arc<State>,
    task: JoinHandle<()>,
}

impl FakeButlerCloud {
    pub async fn start() -> Result<Self, HarnessError> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let url = format!("http://{}", listener.local_addr()?);
        let state = Arc::new(State {
            seen: Mutex::new(Vec::new()),
            plan: Mutex::new("free".into()),
            blobs: Mutex::new(BTreeSet::new()),
            page: Mutex::new(None),
        });
        let router = Router::new().fallback(route).with_state(state.clone());
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        Ok(Self { url, state, task })
    }

    pub fn seen(&self) -> Vec<String> {
        self.state
            .seen
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub fn set_plan(&self, plan: &str) {
        *self
            .state
            .plan
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = plan.to_owned();
    }
}

impl Drop for FakeButlerCloud {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn route(
    AxumState(state): AxumState<Arc<State>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let path = uri.path();
    state
        .seen
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .push(format!("{method} {path}"));
    let account = json!({"id": "acc_fake", "email": "user@example.com", "created_at": "2026-01-01T00:00:00Z"});
    let device = json!({"id": "dev_fake", "name": "Butler", "platform": "macos"});
    if method == Method::POST && path == "/v1/auth/email/start" {
        return StatusCode::ACCEPTED.into_response();
    }
    if method == Method::POST && path == "/v1/auth/email/verify" {
        let input: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        return if input["code"] == "123456" {
            Json(json!({"device_token": "bct_fake", "account": account, "device": device}))
                .into_response()
        } else {
            (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": {"code": "code_invalid", "message": "The code is invalid."}})),
            )
                .into_response()
        };
    }
    if headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        != Some("Bearer bct_fake")
    {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": {"code": "unauthorized", "message": "Unauthorized."}})),
        )
            .into_response();
    }
    authenticated(&state, method, path, &account, &device, &body)
}

fn authenticated(
    state: &State,
    method: Method,
    path: &str,
    account: &Value,
    device: &Value,
    body: &[u8],
) -> Response {
    match (method, path) {
        (Method::GET, "/v1/me") => {
            let plan = state.plan.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
            Json(json!({"account": account, "device": device,
                "entitlements": {"plan": plan, "status": "active", "renews_at": null, "features": {}}})).into_response()
        }
        (Method::GET, "/v1/devices") => Json(json!({"devices": [
            {"id": "dev_fake", "name": "Butler", "platform": "macos", "created_at": "2026-01-01T00:00:00Z", "last_seen_at": null, "current": true},
            {"id": "dev_other", "name": "Other", "platform": "linux", "created_at": "2026-01-01T00:00:00Z", "last_seen_at": null, "current": false}
        ]})).into_response(),
        (Method::DELETE, "/v1/devices/dev_other") | (Method::POST, "/v1/auth/sign-out") => StatusCode::NO_CONTENT.into_response(),
        (Method::POST, "/v1/pages") => {
            let input: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
            let mut page = state.page.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let version = page.as_ref().map_or(1, |(_, version)| version + 1);
            *page = Some((input["source_key"].as_str().unwrap_or_default().to_owned(), version));
            let blobs = state.blobs.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let missing: BTreeSet<_> = input["files"].as_array().into_iter().flatten()
                .filter_map(|file| file["sha256"].as_str())
                .filter(|sha| !blobs.contains(*sha))
                .collect();
            Json(json!({"id": PAGE_ID, "url": PAGE_URL, "version": version, "missing": missing})).into_response()
        }
        (Method::PUT, path) if path.starts_with("/v1/pages/k7m2q9xd4b3hn/blobs/") => {
            let sha = path.trim_start_matches("/v1/pages/k7m2q9xd4b3hn/blobs/");
            state.blobs.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(sha.to_owned());
            StatusCode::NO_CONTENT.into_response()
        }
        (Method::POST, "/v1/pages/k7m2q9xd4b3hn/publish") => {
            let page = state.page.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let version = page.as_ref().map(|(_, version)| version);
            Json(json!({"id": PAGE_ID, "url": PAGE_URL, "version": version})).into_response()
        }
        (Method::GET, "/v1/pages") => {
            let page = state.page.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let pages: Vec<_> = page.iter().map(|(source_key, _)| json!({
                "id": PAGE_ID, "url": PAGE_URL, "title": "Output", "status": "live",
                "size_bytes": 0, "file_count": 0, "updated_at": "2026-01-01T00:00:00Z", "source_key": source_key,
            })).collect();
            Json(json!({"pages": pages, "used": pages.len(), "limit": 3, "badge": true,
                "page_bytes": 10_000_000, "page_files": 200})).into_response()
        }
        (Method::DELETE, "/v1/pages/k7m2q9xd4b3hn") => {
            *state.page.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = None;
            StatusCode::NO_CONTENT.into_response()
        }
        _ => (StatusCode::NOT_FOUND, Json(json!({"error": {"code": "not_found", "message": "Not found."}}))).into_response(),
    }
}
