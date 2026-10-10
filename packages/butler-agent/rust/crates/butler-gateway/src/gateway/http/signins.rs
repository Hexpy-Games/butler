//! Settings → Security → Sign-ins (host only: local client with the admin
//! credential). Passwords go straight to the OS credential store; no route
//! ever answers one.
//!
//! - `GET /security/signins`: availability and one row per site.
//! - `POST /security/signins`: add `{site, username, password}` (or a takeover
//!   save `{origin, username, password}`).
//! - `PATCH /security/signins/{id}`: `{policy}`.
//! - `DELETE /security/signins/{id}`: delete the password and its entry.
//! - `POST /security/signins/site`: `{site, all_conversations}` or `{site, revoke: true}`.
use super::{HttpError, HttpState, json, read_body_with_limit, signin_secrets};
use crate::gateway::protocol::{APP_PROTOCOL_VERSION, ApiEnvelope};
use crate::gateway::{AppSignInCommand, AppSignInUpsert};
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use axum::response::Response;
use butler_platform::secrets::SecretText;
use serde_json::{Value, json};
use std::sync::Arc;

pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let body = if matches!(method, Method::POST | Method::PATCH) {
        let bytes = read_body_with_limit(request.into_body(), 16 * 1024).await?;
        // The body may hold a password: parse into a value dropped right after use.
        Some(serde_json::from_slice::<Value>(&bytes).map_err(|_| HttpError::invalid_json())?)
    } else {
        None
    };
    let body = body.unwrap_or(Value::Null);
    let data = match (&method, path.as_str()) {
        (&Method::GET, "/security/signins") => list(&state).await?,
        (&Method::POST, "/security/signins") => add(&state, body).await?,
        (&Method::POST, "/security/signins/site") => site(&state, &body).await?,
        (&Method::PATCH, p) if p.starts_with("/security/signins/") => {
            let policy = body["policy"].as_str().unwrap_or("");
            if !matches!(policy, "always" | "ask" | "never") {
                return Err(invalid("Unknown sign-in policy."));
            }
            state
                .application
                .signins(AppSignInCommand::SetPolicy {
                    id: entry_id(p)?,
                    policy: policy.into(),
                })
                .await?
        }
        (&Method::DELETE, p) if p.starts_with("/security/signins/") => {
            let id = entry_id(p)?;
            if signin_secrets::available(&state).await {
                signin_secrets::delete(&state, &id).await?;
            }
            state
                .application
                .signins(AppSignInCommand::Delete { id })
                .await?
        }
        _ => return Err(HttpError::public(404, "not_found", "Route not found.")),
    };
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data,
        },
    )
}

fn invalid(message: &str) -> HttpError {
    HttpError::public(400, "invalid_signin_request", message)
}

fn entry_id(path: &str) -> Result<String, HttpError> {
    let id = path.trim_start_matches("/security/signins/");
    uuid::Uuid::parse_str(id)
        .map(|_| id.to_owned())
        .map_err(|_| invalid("Invalid sign-in id."))
}

async fn list(state: &Arc<HttpState>) -> Result<Value, HttpError> {
    let mut rows = state.application.signins(AppSignInCommand::List).await?;
    rows["available"] = json!(signin_secrets::available(state).await);
    Ok(rows)
}

/// The exact login origin for an add: a bare host means `https://<host>`.
pub(super) fn login_origin(raw: &str) -> Option<(String, String)> {
    let raw = raw.trim();
    let candidate = if raw.contains("://") {
        raw.to_owned()
    } else {
        format!("https://{raw}")
    };
    let url = butler_runtime::browser::public_url(&candidate).ok()?;
    let site = butler_runtime::browser::site_of(url.as_str())?;
    site.contains('.')
        .then(|| (url.origin().ascii_serialization(), site))
}

async fn add(state: &Arc<HttpState>, mut body: Value) -> Result<Value, HttpError> {
    let password = match body.get_mut("password") {
        Some(Value::String(value)) => Some(SecretText::new(std::mem::take(value))),
        _ => None,
    };
    let password = password
        .filter(|p| !p.expose().is_empty() && p.expose().len() <= 1024)
        .ok_or_else(|| invalid("A password is required."))?;
    let username = body["username"].as_str().unwrap_or("").trim().to_owned();
    if username.is_empty() || username.len() > 256 {
        return Err(invalid("A username is required."));
    }
    let raw = body["origin"]
        .as_str()
        .or_else(|| body["site"].as_str())
        .unwrap_or("");
    let (origin, site) = login_origin(raw).ok_or_else(|| invalid("Enter a site address."))?;
    if !signin_secrets::available(state).await {
        return Err(HttpError::public(
            409,
            "signin_unavailable",
            "Sign-ins need the system keychain.",
        ));
    }
    let source = if body["origin"].is_string() {
        "takeover"
    } else {
        "manual"
    };
    store(
        state,
        AppSignInUpsert {
            site,
            origin,
            username,
            source: source.into(),
        },
        password,
    )
    .await
}

/// Upserts the entry, then writes its password; an insert whose secret fails is undone.
pub(super) async fn store(
    state: &Arc<HttpState>,
    input: AppSignInUpsert,
    password: SecretText,
) -> Result<Value, HttpError> {
    let saved = state
        .application
        .signins(AppSignInCommand::Upsert(input))
        .await?;
    if saved["action"] == "skipped" {
        return Ok(json!({"id": saved["id"], "action": "skipped"}));
    }
    let id = saved["id"].as_str().unwrap_or("").to_owned();
    if let Err(error) = signin_secrets::set(state, &id, password).await {
        if saved["action"] == "inserted" {
            state
                .application
                .signins(AppSignInCommand::Forget { id })
                .await?;
        }
        return Err(error);
    }
    Ok(json!({"id": id, "action": saved["action"]}))
}

async fn site(state: &Arc<HttpState>, body: &Value) -> Result<Value, HttpError> {
    let site = body["site"].as_str().unwrap_or("");
    if butler_runtime::browser::site_of_host(site).as_deref() != Some(site) || !site.contains('.') {
        return Err(invalid("Invalid site."));
    }
    if body["revoke"] == true {
        let revoked = state
            .application
            .signins(AppSignInCommand::Revoke { site: site.into() })
            .await?;
        super::browser_host::signed_in::fence_site(state, site);
        return Ok(revoked);
    }
    let value = body["all_conversations"]
        .as_bool()
        .ok_or_else(|| invalid("Missing setting."))?;
    state
        .application
        .signins(AppSignInCommand::SetAllConversations {
            site: site.into(),
            value,
        })
        .await
        .map_err(Into::into)
}
