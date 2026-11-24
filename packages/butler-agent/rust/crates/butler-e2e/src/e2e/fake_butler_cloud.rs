//! Stub-only Butler account service.
use sha2::{Digest, Sha256};
use std::sync::PoisonError;
use std::{
    collections::{BTreeSet, HashMap},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use axum::{
    Json, Router,
    body::Bytes,
    extract::{
        DefaultBodyLimit, Path, State as AxumState, WebSocketUpgrade,
        ws::{CloseFrame, Message, rejection::WebSocketUpgradeRejection},
    },
    http::{HeaderMap, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use tokio::{sync::mpsc, task::JoinHandle};

use super::HarnessError;

mod canon;

const PAGE_ID: &str = "k7m2q9xd4b3hn";
const PAGE_URL: &str = "https://pages.test/p/k7m2q9xd4b3hn/";

struct State {
    seen: Mutex<Vec<String>>,
    plan: Mutex<String>,
    devices: AtomicU64,
    emails: Mutex<HashMap<u64, String>>,
    canon: Mutex<canon::Canon>,
    backup: Mutex<Backup>,
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
            devices: AtomicU64::new(0),
            emails: Mutex::default(),
            canon: Mutex::default(),
            backup: Mutex::default(),
            blobs: Mutex::new(BTreeSet::new()),
            page: Mutex::new(None),
        });
        let router = Router::new()
            .route(
                "/v1/canon/spaces/{id}/socket",
                axum::routing::get(canon_socket),
            )
            .fallback(route)
            .layer(DefaultBodyLimit::max(8 * 1024 * 1024 + 32))
            .with_state(state.clone());
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

    /// Flips the last byte of every stored chunk; calling it again undoes it.
    pub fn flip_chunks(&self) {
        let mut backup = self
            .state
            .backup
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for chunk in backup.chunks.values_mut() {
            let mut bytes = chunk.to_vec();
            if let Some(last) = bytes.last_mut() {
                *last ^= 1;
            }
            *chunk = bytes.into();
        }
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
    if method == Method::POST && path == "/v1/auth/email/start" {
        return StatusCode::ACCEPTED.into_response();
    }
    if method == Method::POST && path == "/v1/auth/email/verify" {
        let input: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        return if input["code"] == "123456" {
            let id = state.devices.fetch_add(1, Ordering::Relaxed);
            let Some(email) = input["email"].as_str() else {
                return failure(StatusCode::BAD_REQUEST, "invalid_request");
            };
            state
                .emails
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(id, email.to_owned());
            Json(json!({"device_token": format!("bct_fake{id}"), "account": account(email), "device": device(id)}))
                .into_response()
        } else {
            (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": {"code": "code_invalid", "message": "The code is invalid."}})),
            )
                .into_response()
        };
    }
    let Some((device_id, email)) = state.bearer(&headers) else {
        return failure(StatusCode::UNAUTHORIZED, "unauthorized");
    };
    let account = account(&email);
    let device = device(device_id);
    if let Some(path) = path.strip_prefix("/v1/canon/") {
        return state
            .canon
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .route(method, path, uri.query(), &account, &device, &body);
    }
    if let Some(path) = path.strip_prefix("/v1/backup") {
        let quota = match state
            .plan
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_str()
        {
            "plus" => 20_000_000_000,
            "pro" => 100_000_000_000,
            "enterprise" => 1_000_000_000_000,
            _ => 0,
        };
        return state
            .backup
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .route(&method, path, &headers, body, quota);
    }
    authenticated(&state, method, path, &account, &device, &body)
}

impl State {
    fn bearer(&self, headers: &HeaderMap) -> Option<(u64, String)> {
        let id = headers
            .get("authorization")?
            .to_str()
            .ok()?
            .strip_prefix("Bearer bct_fake")?
            .parse()
            .ok()?;
        let emails = self
            .emails
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Some((id, emails.get(&id)?.clone()))
    }
}

fn account(email: &str) -> Value {
    let hash = format!("{:x}", Sha256::digest(email.as_bytes()));
    json!({"id": format!("acc_{}", &hash[..16]), "email": email})
}

fn device(id: u64) -> Value {
    let id = if id == 0 {
        "dev_fake".to_owned()
    } else {
        format!("dev_fake_{id}")
    };
    json!({"id": id, "name": "Butler", "platform": "macos"})
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

#[derive(Default)]
struct Backup {
    chunks: HashMap<String, Bytes>,
    snapshots: [Option<Snapshot>; 3],
}

struct Snapshot {
    version: u64,
    created_at: String,
    bytes: Bytes,
}

impl Backup {
    fn route(
        &mut self,
        method: &Method,
        path: &str,
        headers: &HeaderMap,
        body: Bytes,
        quota: u64,
    ) -> Response {
        match (method, path) {
            (&Method::GET, "") => {
                let used: usize = self.chunks.values().map(Bytes::len).sum();
                let snapshots: Vec<_> = self.snapshots.iter().enumerate().filter_map(|(slot, item)| {
                    let item = item.as_ref()?;
                    Some(json!({"slot":slot,"version":item.version,"size":item.bytes.len(),"created_at":item.created_at}))
                }).collect();
                return Json(json!({"quota_bytes":quota,"used_bytes":used,"snapshots":snapshots}))
                    .into_response();
            }
            (&Method::DELETE, "") => {
                if self.chunks.is_empty() {
                    self.snapshots = Default::default();
                    return Json(json!({"done": true})).into_response();
                }
                let ids: Vec<_> = self.chunks.keys().take(1000).cloned().collect();
                for id in ids {
                    self.chunks.remove(&id);
                }
                return Json(json!({"done": false})).into_response();
            }
            _ => (),
        }
        if quota == 0 {
            return failure(StatusCode::FORBIDDEN, "backup_not_in_plan");
        }
        if let Some(slot) = path
            .strip_prefix("/snapshots/")
            .and_then(|slot| slot.parse::<usize>().ok())
            .and_then(|slot| self.snapshots.get_mut(slot))
        {
            return Self::snapshot(slot, method, headers, body);
        }
        if *method == Method::POST && matches!(path, "/chunks/missing" | "/chunks/delete") {
            let input: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            let Some(ids) = input["ids"]
                .as_array()
                .filter(|ids| (1..=1000).contains(&ids.len()))
            else {
                return failure(StatusCode::BAD_REQUEST, "invalid_request");
            };
            let Some(ids) = ids
                .iter()
                .map(|id| id.as_str().filter(|id| valid_id(id)))
                .collect::<Option<Vec<_>>>()
            else {
                return failure(StatusCode::BAD_REQUEST, "invalid_request");
            };
            if path.ends_with("/missing") {
                let missing: Vec<_> = ids
                    .into_iter()
                    .filter(|id| !self.chunks.contains_key(*id))
                    .collect();
                return Json(json!({"missing": missing})).into_response();
            }
            let deleted = ids
                .into_iter()
                .filter_map(|id| self.chunks.remove(id))
                .count();
            return Json(json!({"deleted": deleted})).into_response();
        }
        if let Some(id) = path.strip_prefix("/chunks/").filter(|id| valid_id(id)) {
            if *method == Method::PUT {
                if self.chunks.contains_key(id) {
                    return Json(json!({"stored": false})).into_response();
                }
                let used: usize = self.chunks.values().map(Bytes::len).sum();
                if used as u64 + body.len() as u64 > quota {
                    return failure(StatusCode::FORBIDDEN, "backup_quota_exceeded");
                }
                self.chunks.insert(id.to_owned(), body);
                return (StatusCode::CREATED, Json(json!({"stored": true}))).into_response();
            }
            if *method == Method::GET
                && let Some(body) = self.chunks.get(id)
            {
                return ([("content-type", "application/octet-stream")], body.clone())
                    .into_response();
            }
        }
        failure(StatusCode::NOT_FOUND, "not_found")
    }

    fn snapshot(
        slot: &mut Option<Snapshot>,
        method: &Method,
        headers: &HeaderMap,
        body: Bytes,
    ) -> Response {
        if *method == Method::PUT {
            let version = slot.as_ref().map_or(0, |snapshot| snapshot.version);
            let expected = format!("\"{version}\"");
            if headers
                .get("if-match")
                .and_then(|value| value.to_str().ok())
                != Some(expected.as_str())
            {
                return failure(StatusCode::CONFLICT, "version_conflict");
            }
            let version = version + 1;
            *slot = Some(Snapshot {
                version,
                created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                bytes: body,
            });
            return Json(json!({"version": version})).into_response();
        }
        if *method == Method::GET
            && let Some(snapshot) = slot
        {
            let hash = format!("{:x}", Sha256::digest(&snapshot.bytes));
            return (
                [
                    ("etag", format!("\"{}\"", snapshot.version)),
                    ("x-content-sha256", hash),
                ],
                snapshot.bytes.clone(),
            )
                .into_response();
        }
        failure(StatusCode::NOT_FOUND, "not_found")
    }
}

fn failure(status: StatusCode, code: &str) -> Response {
    (
        status,
        Json(json!({"error": {"code": code, "message": code}})),
    )
        .into_response()
}

fn valid_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn pending(invite: &Value, now: &str) -> bool {
    invite["active"] == true
        && invite["view"]["expires_at"]
            .as_str()
            .is_some_and(|expires| expires > now)
}

fn timestamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

async fn canon_socket(
    AxumState(state): AxumState<Arc<State>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    state
        .seen
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .push(format!("GET /v1/canon/spaces/{id}/socket"));
    let Some((_, email)) = state.bearer(&headers) else {
        return failure(StatusCode::UNAUTHORIZED, "unauthorized");
    };
    let account = account(&email);
    let (tx, mut rx) = mpsc::unbounded_channel();
    let mut canon = state.canon.lock().unwrap_or_else(PoisonError::into_inner);
    let Some(space) = canon.spaces.get_mut(&id).filter(|space| {
        space
            .role(account["id"].as_str().unwrap_or_default())
            .is_some()
    }) else {
        return failure(StatusCode::NOT_FOUND, "not_found");
    };
    let Ok(upgrade) = upgrade else {
        return failure(StatusCode::UPGRADE_REQUIRED, "upgrade_required");
    };
    space.sockets.push((email, tx));
    upgrade.on_upgrade(move |mut socket| async move {
        loop {
            tokio::select! {
                frame = rx.recv() => {
                    let Some(frame) = frame else { break };
                    let closing = matches!(frame, Message::Close(_));
                    if socket.send(frame).await.is_err() || closing {
                        break;
                    }
                }
                incoming = socket.recv() => match incoming {
                    Some(Ok(Message::Text(_) | Message::Binary(_))) => {
                        let _ = socket.send(Message::Close(Some(CloseFrame { code: 1008, reason: "read-only".into() }))).await;
                        break;
                    }
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                    _ => break,
                },
            }
        }
    })
}
