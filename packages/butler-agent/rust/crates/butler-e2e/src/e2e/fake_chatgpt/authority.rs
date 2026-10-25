use super::{State as Authority, tokens};
use axum::{
    Json, Router,
    extract::{Form, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::json;
use std::{collections::BTreeMap, sync::Arc};

pub(super) fn router(state: Arc<Authority>) -> Router {
    Router::new()
        .route("/.well-known/openid-configuration", get(discovery))
        .route("/.well-known/jwks.json", get(jwks))
        .route("/api/accounts/authorize", get(authorize))
        .route("/api/accounts/oauth/token", post(tokens::exchange))
        .route("/api/accounts/oauth/revoke", post(revoke))
        .route("/v1/models", get(super::models::list))
        .with_state(state)
}
async fn discovery(
    State(state): State<Arc<Authority>>,
    headers: axum::http::HeaderMap,
) -> Json<serde_json::Value> {
    state.record("discovery", &BTreeMap::new(), &headers);
    let issuer = &state.issuer;
    Json(
        json!({"issuer":issuer,"authorization_endpoint":format!("{issuer}/api/accounts/authorize"),
        "token_endpoint":format!("{issuer}/api/accounts/oauth/token"),"revocation_endpoint":format!("{issuer}/api/accounts/oauth/revoke"),
        "jwks_uri":format!("{issuer}/.well-known/jwks.json")}),
    )
}
async fn jwks(
    State(state): State<Arc<Authority>>,
    headers: axum::http::HeaderMap,
) -> Json<serde_json::Value> {
    state.record("jwks", &BTreeMap::new(), &headers);
    Json(tokens::jwks())
}
async fn authorize(
    State(state): State<Arc<Authority>>,
    headers: axum::http::HeaderMap,
    Query(params): Query<BTreeMap<String, String>>,
) -> Response {
    state.record("authorize", &params, &headers);
    if !valid_authorize(&params) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let mut params = params;
    let dynamic = params
        .get("client_id")
        .is_some_and(|id| id == "dynamic_agent_client");
    if dynamic {
        let mut registrations = state
            .registrations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *registrations += 1;
        params.insert("client_id".into(), format!("oaiapp_e2e_{}", *registrations));
    }
    let client = params.get("client_id").cloned().unwrap_or_default();
    let mut clients = state
        .clients
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if dynamic {
        clients.insert(client);
    } else if !clients.contains(&client) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    drop(clients);
    let Ok(mut redirect) =
        url::Url::parse(params.get("redirect_uri").map(String::as_str).unwrap_or(""))
    else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let code = uuid::Uuid::new_v4().to_string();
    state.issue(&code);
    redirect
        .query_pairs_mut()
        .append_pair(
            "state",
            params.get("state").map(String::as_str).unwrap_or(""),
        )
        .append_pair("code", &code)
        .append_pair("scope", butler_models::models::chatgpt::SCOPES);
    if dynamic {
        redirect.query_pairs_mut().append_pair(
            "client_id",
            params.get("client_id").map(String::as_str).unwrap_or(""),
        );
    }
    state
        .grants
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(code, params);
    (
        StatusCode::FOUND,
        [(axum::http::header::LOCATION, redirect.as_str())],
    )
        .into_response()
}
fn valid_authorize(p: &BTreeMap<String, String>) -> bool {
    use butler_models::models::chatgpt::{RESOURCE, SCOPES};
    let get = |key: &str| p.get(key).map(String::as_str).unwrap_or("");
    let redirect = url::Url::parse(get("redirect_uri"));
    get("response_type") == "code"
        && get("scope") == SCOPES
        && get("resource") == RESOURCE
        && get("code_challenge_method") == "S256"
        && !get("code_challenge").is_empty()
        && !get("state").is_empty()
        && !get("nonce").is_empty()
        && get("ext_agent_host_id")
            .strip_prefix("urn:uuid:")
            .and_then(|s| uuid::Uuid::parse_str(s).ok())
            .is_some_and(|id| id.get_version_num() == 4)
        && redirect.is_ok_and(|url| {
            url.scheme() == "http"
                && url.host_str() == Some("127.0.0.1")
                && url.path() == "/auth/callback"
                && url.port().is_some()
        })
        && if get("client_id") == "dynamic_agent_client" {
            get("agent_name_hint") == "Butler"
        } else {
            !get("client_id").is_empty() && !p.contains_key("agent_name_hint")
        }
}
async fn revoke(
    State(state): State<Arc<Authority>>,
    headers: axum::http::HeaderMap,
    Form(params): Form<BTreeMap<String, String>>,
) -> StatusCode {
    state.record("revoke", &params, &headers);
    let delay = *state
        .revoke_delay
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    tokio::time::sleep(delay).await;
    StatusCode::OK
}
