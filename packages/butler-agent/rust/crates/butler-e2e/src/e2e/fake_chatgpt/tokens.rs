#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test-only signing material"
)]
use super::State as Authority;
use axum::{
    Json,
    extract::{Form, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use ring::{
    rand::SystemRandom,
    signature::{RSA_PKCS1_SHA256, RsaKeyPair},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::Arc};

/// This committed RSA key is test-only and is never used outside the E2E fake authority.
fn key() -> RsaKeyPair {
    RsaKeyPair::from_pkcs8(include_bytes!(
        "../../../fixtures/siwc/test-signing-key.pk8"
    ))
    .expect("test key")
}
pub(super) fn jwks() -> Value {
    let key = key();
    let public = key.public();
    let components: ring::rsa::PublicKeyComponents<Vec<u8>> = public.into();
    json!({"keys":[{"kid":"test-signing-key","kty":"RSA","use":"sig","alg":"RS256","n":B64.encode(components.n),"e":B64.encode(components.e)}]})
}
pub(super) async fn exchange(
    State(state): State<Arc<Authority>>,
    headers: axum::http::HeaderMap,
    Form(params): Form<BTreeMap<String, String>>,
) -> Response {
    state.record("token", &params, &headers);
    if params
        .get("grant_type")
        .is_some_and(|g| g == "refresh_token")
    {
        return refresh(&state, &params);
    }
    let faults = state.faults();
    let get = |key: &str| params.get(key).map(String::as_str).unwrap_or("");
    let grant = state
        .grants
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(get("code"));
    let Some(grant) = grant else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_grant"})),
        )
            .into_response();
    };
    let valid = get("grant_type") == "authorization_code"
        && get("resource") == butler_models::models::chatgpt::RESOURCE
        && ["client_id", "redirect_uri"]
            .iter()
            .all(|key| grant.get(*key).is_some_and(|v| v == get(key)))
        && grant.get("code_challenge").is_some_and(|challenge| {
            *challenge == B64.encode(Sha256::digest(get("code_verifier")))
        });
    if !valid || faults.invalid_grant {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_grant"})),
        )
            .into_response();
    }
    let token = id_token(&state, &grant);
    let mut response = issue(&state, get("client_id"));
    response["id_token"] = token.into();
    Json(response).into_response()
}
fn id_token(state: &Authority, grant: &BTreeMap<String, String>) -> String {
    let faults = state.faults();
    let fault = faults.id_token.as_deref().unwrap_or("");
    let now = chrono::Utc::now().timestamp();
    let mut claims = json!({"iss":state.issuer,"aud":grant.get("client_id"),"iat":now,"exp":now+3600,
        "nonce":grant.get("nonce"),"sub":faults.subject.as_deref().unwrap_or("e2e-subject"),"email":"e2e-user@example.com","name":"Test account"});
    match fault {
        "iss" => claims["iss"] = "https://wrong.invalid".into(),
        "aud" => claims["aud"] = "wrong-client".into(),
        "exp" => claims["exp"] = (now - 60).into(),
        "nonce" => claims["nonce"] = "wrong-nonce".into(),
        _ => {}
    }
    let header = json!({"alg":if fault == "alg" { "none" } else { "RS256" },"kid":if fault == "kid" { "unknown" } else { "test-signing-key" }});
    let message = format!(
        "{}.{}",
        B64.encode(header.to_string()),
        B64.encode(claims.to_string())
    );
    let key = key();
    let mut signature = vec![0; key.public().modulus_len()];
    key.sign(
        &RSA_PKCS1_SHA256,
        &SystemRandom::new(),
        message.as_bytes(),
        &mut signature,
    )
    .expect("test signature");
    if fault == "signature" {
        signature[0] ^= 1;
    }
    format!("{message}.{}", B64.encode(signature))
}

pub(super) fn issue(state: &Authority, client: &str) -> Value {
    let refresh = format!("refresh-{}", uuid::Uuid::new_v4());
    state
        .refresh
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(refresh.clone(), client.into());
    json!({"access_token":format!("access-{}",uuid::Uuid::new_v4()), "refresh_token":refresh,
        "token_type":"Bearer", "expires_in":3600, "earliest_refresh_at":null,
        "scope":if state.faults().no_plan { "openid profile email offline_access resource.invoke" }
            else { butler_models::models::chatgpt::SCOPES }})
}
fn refresh(state: &Authority, params: &BTreeMap<String, String>) -> Response {
    let faults = state.faults();
    if faults.refresh_503 {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    if faults.invalid_client {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_client"})),
        )
            .into_response();
    }
    let get = |k: &str| params.get(k).map(String::as_str).unwrap_or("");
    if get("resource") != butler_models::models::chatgpt::RESOURCE || params.contains_key("scope") {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let mut refresh = state
        .refresh
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if faults.refresh_reused
        || refresh
            .get(get("refresh_token"))
            .is_none_or(|client| client != get("client_id"))
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"refresh_token_reused"})),
        )
            .into_response();
    }
    refresh.remove(get("refresh_token"));
    drop(refresh);
    Json(issue(state, get("client_id"))).into_response()
}
