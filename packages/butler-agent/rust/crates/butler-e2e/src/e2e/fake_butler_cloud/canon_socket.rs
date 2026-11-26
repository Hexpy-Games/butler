use std::sync::{Arc, PoisonError};

use axum::{
    extract::{
        Path, State as AxumState,
        ws::{CloseFrame, Message, WebSocketUpgrade, rejection::WebSocketUpgradeRejection},
    },
    http::{HeaderMap, StatusCode},
    response::Response,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;

use super::{State, failure};

pub(super) fn pending(invite: &Value, now: &str) -> bool {
    invite["active"] == true
        && invite["view"]["expires_at"]
            .as_str()
            .is_some_and(|expires| expires > now)
}

pub(super) fn timestamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub(super) async fn canon_socket(
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

impl State {
    pub(super) fn bearer(&self, headers: &HeaderMap) -> Option<(u64, String)> {
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

pub(super) fn account(email: &str) -> Value {
    let hash = format!("{:x}", Sha256::digest(email.as_bytes()));
    json!({"id": format!("acc_{}", &hash[..16]), "email": email})
}
