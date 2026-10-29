//! Source App session create/list routes.

use std::sync::Arc;

use crate::gateway::{
    AppListCursor, AppListPage,
    crypto::{constant_time_eq, hmac_sha256_base64},
};
use axum::{
    body::Body,
    http::{Request, StatusCode, Uri},
    response::Response,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::Value;

use super::{HttpError, HttpState, MAX_REQUEST_BODY_SIZE, json, query, read_body_with_limit};
use crate::gateway::{
    AppChatKind, AppCreateSessionInput, AppCreateSessionRequest, AppWorkspaceMode,
    protocol::{APP_PROTOCOL_VERSION, ApiEnvelope},
};

pub(super) async fn chats(state: Arc<HttpState>, uri: &Uri) -> Result<Response, HttpError> {
    let page = page_params(&state, uri).await?;
    let chats = state
        .application
        .list_chats(page.clone().map(|mut page| {
            page.limit += 1;
            page
        }))
        .await?;
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: page_response(chats, page, None, &state.session_cursor_secret)?,
        },
    )
}

pub(super) async fn list(state: Arc<HttpState>, uri: &Uri) -> Result<Response, HttpError> {
    let params = query(uri);
    let kind = params
        .get("kind")
        .filter(|kind| matches!(kind.as_str(), "chat" | "project"))
        .cloned();
    let project_id = params.get("project_id").cloned();
    let page = page_params(&state, uri).await?;
    let sessions = state
        .application
        .list_sessions(
            kind,
            project_id,
            page.clone().map(|mut page| {
                page.limit += 1;
                page
            }),
        )
        .await?;
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: page_response(
                sessions,
                page,
                Some("sessions"),
                &state.session_cursor_secret,
            )?,
        },
    )
}

pub(super) async fn project_list(state: Arc<HttpState>, uri: &Uri) -> Result<Response, HttpError> {
    let project_id = query(uri).get("project_id").cloned();
    let sessions = state
        .application
        .list_sessions(Some("project".into()), project_id.clone(), None)
        .await?;
    let mut data = serde_json::json!({"sessions": sessions});
    if let Some(project_id) = project_id {
        data["project_id"] = project_id.into();
    }
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data,
        },
    )
}

pub(super) async fn create(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
    let request = parse_request(&value).ok_or_else(|| {
        HttpError::public(
            400,
            "invalid_request",
            "A valid session kind and workspace mode are required.",
        )
    })?;
    let created = state
        .application
        .create_session(request, state.shutdown.clone())
        .await?;
    json(
        StatusCode::CREATED,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: created,
        },
    )
}

fn parse_request(value: &Value) -> Option<AppCreateSessionRequest> {
    let object = value.as_object()?;
    let kind = match object.get("kind")?.as_str()? {
        "chat" => AppChatKind::Chat,
        "project" => AppChatKind::Project,
        _ => return None,
    };
    let workspace_mode = match object.get("workspace_mode") {
        None => AppWorkspaceMode::Local,
        Some(Value::String(mode)) if mode == "local" => AppWorkspaceMode::Local,
        Some(Value::String(mode)) if mode == "worktree" && kind == AppChatKind::Project => {
            AppWorkspaceMode::Worktree
        }
        _ => return None,
    };
    for field in [
        "title",
        "initial_message",
        "project_id",
        "session_hint",
        "idempotency_key",
        "group_id",
    ] {
        if object.get(field).is_some_and(|value| !value.is_string()) {
            return None;
        }
    }
    let string = |key| object.get(key).and_then(Value::as_str).map(str::to_owned);
    Some(AppCreateSessionRequest {
        input: AppCreateSessionInput {
            kind,
            title: string("title"),
            project_id: string("project_id"),
            session_hint: string("session_hint"),
            group_id: string("group_id"),
        },
        workspace_mode,
    })
}

async fn page_params(state: &HttpState, uri: &Uri) -> Result<Option<AppListPage>, HttpError> {
    let params = query(uri);
    if !params.contains_key("limit")
        && !params.contains_key("cursor")
        && !params.contains_key("offset")
    {
        return Ok(None);
    }
    let invalid = || HttpError::public(400, "invalid_page", "Invalid page.");
    let limit = params
        .get("limit")
        .map(|s| s.parse::<u32>())
        .transpose()
        .map_err(|_| invalid())?
        .unwrap_or(50);
    if !(1..=200).contains(&limit) || params.contains_key("offset") {
        return Err(invalid());
    }
    let scope = format!(
        "{}:{}:{}",
        uri.path(),
        params.get("kind").map_or("", String::as_str),
        params.get("project_id").map_or("", String::as_str)
    );
    let cursor = if let Some(token) = params.get("cursor") {
        decode_cursor(token, &state.session_cursor_secret, &scope)?
    } else {
        let expires = now() + 300;
        AppListCursor {
            revision: state.application.list_revision().await?,
            expires,
            after: None,
            scope,
        }
    };
    Ok(Some(AppListPage { limit, cursor }))
}

fn page_response<T: serde::Serialize>(
    items: Vec<T>,
    page: Option<AppListPage>,
    key: Option<&str>,
    secret: &str,
) -> Result<Value, HttpError> {
    if let Some(page) = page {
        let mut items = serde_json::to_value(items).map_err(|_| HttpError::Internal)?;
        let rows = items.as_array_mut().ok_or(HttpError::Internal)?;
        let more = rows.len() > page.limit as usize;
        rows.truncate(page.limit as usize);
        let next = if more {
            let mut cursor = page.cursor;
            cursor.after = Some(
                rows.last()
                    .and_then(|r| r["id"].as_str())
                    .ok_or(HttpError::Internal)?
                    .into(),
            );
            Some(encode_cursor(&cursor, secret)?)
        } else {
            None
        };
        return Ok(serde_json::json!({"items":items,"next_cursor":next}));
    }
    match key {
        Some(key) => Ok(serde_json::json!({key: items})),
        None => serde_json::to_value(items).map_err(|_| HttpError::Internal),
    }
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}
fn encode_cursor(cursor: &AppListCursor, secret: &str) -> Result<String, HttpError> {
    let payload =
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(cursor).map_err(|_| HttpError::Internal)?);
    let signature = hmac_sha256_base64(secret.as_bytes(), payload.as_bytes());
    Ok(format!("{payload}.{signature}"))
}
fn decode_cursor(token: &str, secret: &str, scope: &str) -> Result<AppListCursor, HttpError> {
    let resync = || HttpError::public(409, "list_cursor_resync_required", "Reload the list.");
    let (payload, signature) = token.split_once('.').ok_or_else(resync)?;
    let expected = hmac_sha256_base64(secret.as_bytes(), payload.as_bytes());
    if !constant_time_eq(expected.as_bytes(), signature.as_bytes()) {
        return Err(resync());
    }
    let decoded = URL_SAFE_NO_PAD.decode(payload).map_err(|_| resync())?;
    let cursor: AppListCursor = serde_json::from_slice(&decoded).map_err(|_| resync())?;
    if cursor.expires <= now() || cursor.scope != scope {
        return Err(resync());
    }
    Ok(cursor)
}
