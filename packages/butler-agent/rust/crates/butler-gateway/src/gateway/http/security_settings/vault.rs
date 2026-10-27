//! Settings → Browser → Payment methods and Profile details (host only: a
//! local client with the admin credential). Card numbers, CVCs and identity
//! numbers go straight to the OS credential store; only an item's reveal,
//! after the user verifies themselves to the operating system, answers one.
//!
//! - `GET /security/vault`: availability, cards, profiles, purchase sites.
//! - `POST /security/vault/cards` | `/profiles`: add.
//! - `PATCH|DELETE /security/vault/{cards|profiles}/{id}`: change or delete.
//! - `POST /security/vault/{cards|profiles}/{id}/reveal`: the number after OS user verification.
//! - `POST /security/vault/{cards|profiles}/{id}/sites`: `{site, allow}` fill without asking.
//! - `POST /security/vault/purchase-sites`: `{site, allow}` purchase without the final card.
mod cards;
mod profiles;
pub(in crate::gateway::http) mod secret;

use crate::gateway::AppVaultCommand;
use crate::gateway::http::{HttpError, HttpState, json, read_body_with_limit, signin_secrets};
use crate::gateway::protocol::{APP_PROTOCOL_VERSION, ApiEnvelope};
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use axum::response::Response;
use serde_json::{Value, json};
use std::sync::Arc;

pub(super) fn invalid(field: &str) -> HttpError {
    HttpError::public(400, "invalid_vault_request", &format!("Check {field}."))
}

pub(super) fn unavailable() -> HttpError {
    HttpError::public(
        409,
        "vault_unavailable",
        "Payment methods need the system password store.",
    )
}

pub(super) fn not_found() -> HttpError {
    HttpError::public(404, "vault_item_missing", "That item is gone.")
}

pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let body = if matches!(method, Method::POST | Method::PATCH) {
        let bytes = read_body_with_limit(request.into_body(), 16 * 1024).await?;
        // The body may hold a card number: parse into a value whose secret strings are taken out.
        serde_json::from_slice::<Value>(&bytes).map_err(|_| HttpError::invalid_json())?
    } else {
        Value::Null
    };
    let data = match (&method, path.as_str()) {
        (&Method::GET, "/security/vault") => list(&state).await?,
        (&Method::POST, "/security/vault/purchase-sites") => {
            let site =
                site_key(body["site"].as_str().unwrap_or("")).ok_or_else(|| invalid("site"))?;
            let allow = body["allow"].as_bool().ok_or_else(|| invalid("allow"))?;
            state
                .application
                .vault(AppVaultCommand::PurchaseSite { site, allow })
                .await?
        }
        (&Method::POST, "/security/vault/cards") => cards::add(&state, body).await?,
        (&Method::POST, "/security/vault/profiles") => profiles::save(&state, None, body).await?,
        _ => item(&state, &method, &path, body).await?,
    };
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data,
        },
    )
}

async fn item(
    state: &Arc<HttpState>,
    method: &Method,
    path: &str,
    body: Value,
) -> Result<Value, HttpError> {
    let rest = path.strip_prefix("/security/vault/").unwrap_or("");
    let mut parts = rest.split('/');
    let kind = match parts.next() {
        Some("cards") => "card",
        Some("profiles") => "profile",
        _ => return Err(HttpError::public(404, "not_found", "Route not found.")),
    };
    let id = parts
        .next()
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        .ok_or_else(|| invalid("id"))?
        .to_owned();
    match (method, parts.next(), parts.next()) {
        (&Method::PATCH, None, _) if kind == "card" => cards::update(state, &id, body).await,
        (&Method::PATCH, None, _) => profiles::save(state, Some(&id), body).await,
        (&Method::DELETE, None, _) => delete(state, kind, &id).await,
        (&Method::POST, Some("reveal"), None) if kind == "card" => {
            cards::reveal(state, &id, &body).await
        }
        (&Method::POST, Some("reveal"), None) => profiles::reveal(state, &id, &body).await,
        (&Method::POST, Some("sites"), None) => {
            let site =
                site_key(body["site"].as_str().unwrap_or("")).ok_or_else(|| invalid("site"))?;
            let allow = body["allow"].as_bool().ok_or_else(|| invalid("allow"))?;
            Ok(state
                .application
                .vault(AppVaultCommand::SetSite {
                    kind,
                    id,
                    site,
                    allow,
                })
                .await?)
        }
        _ => Err(HttpError::public(404, "not_found", "Route not found.")),
    }
}

async fn list(state: &Arc<HttpState>) -> Result<Value, HttpError> {
    let mut view = state.application.vault(AppVaultCommand::List).await?;
    let available = signin_secrets::available(state).await;
    if available {
        for profile in view["profiles"].as_array().into_iter().flatten() {
            if let Some(id) = profile["id"].as_str() {
                signin_secrets::migrate_profile(state, id).await?;
            }
        }
    }
    view["available"] = json!(available);
    view["reveal_available"] = json!(butler_platform::user_auth::available());
    Ok(view)
}

/// Deletes the item's secret first, then its row.
async fn delete(state: &Arc<HttpState>, kind: &'static str, id: &str) -> Result<Value, HttpError> {
    if signin_secrets::available(state).await {
        let service = service(kind);
        signin_secrets::delete_in(state, service, id).await?;
    }
    Ok(state
        .application
        .vault(AppVaultCommand::Delete {
            kind,
            id: id.to_owned(),
        })
        .await?)
}

pub(in crate::gateway::http) fn service(kind: &str) -> &'static str {
    if kind == "card" {
        signin_secrets::PAYMENT_SERVICE
    } else {
        signin_secrets::AUTOFILL_SERVICE
    }
}

/// A registrable site from a bare site, a host or a URL.
pub(super) fn site_key(raw: &str) -> Option<String> {
    let raw = raw.trim().to_ascii_lowercase();
    let site = if raw.contains("://") {
        butler_runtime::browser::site_of(&raw)?
    } else {
        butler_runtime::browser::site_of_host(raw.split('/').next().unwrap_or(""))?
    };
    (site.contains('.') && site.len() <= 253).then_some(site)
}

/// The vault item a fill names, if it still exists.
pub(in crate::gateway::http) async fn item_meta(
    state: &Arc<HttpState>,
    kind: &'static str,
    id: &str,
) -> Result<Option<Value>, HttpError> {
    let value = state
        .application
        .vault(AppVaultCommand::Item {
            kind,
            id: id.to_owned(),
        })
        .await?;
    Ok(Some(value["item"].clone()).filter(|item| !item.is_null()))
}
