//! Sign-in fill: Rust checks the tab, grant, entry and policy, mints a
//! single-use 10 s token and sends only the token to main. Main pulls the
//! password once over the authenticated credentials route and types it.
//! The password never rides the host stream or enters any result or audit.
use super::super::signin_secrets;
use super::{HttpError, HttpState, error};
use crate::gateway::AppSignInCommand;
use axum::{
    body::Body,
    http::{HeaderValue, StatusCode, header},
    response::Response,
};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::{Duration, Instant};

const TOKEN_TTL: Duration = Duration::from_secs(10);
const RESULTS: &[&str] = &["filled", "no_fields", "origin_mismatch", "user_required"];
const HUMAN_STEPS: &[&str] = &["mfa", "passkey", "captcha", "secure_keypad", "unknown_form"];

pub(super) struct Fill {
    entry: String,
    origins: Vec<String>,
    expires: Instant,
}

fn refused(reason: &str, recovery: &str) -> Value {
    json!({"status":"not_dispatched","reason":reason,"recovery":recovery})
}

/// The tab's site entry (`signin.lookup`), after the signed-in fence admitted the call.
pub(super) async fn lookup(state: &Arc<HttpState>, tab: &Value) -> Result<Value, HttpError> {
    if tab["profile"] != "signed_in" {
        return Ok(refused(
            "signed_in_tab_required",
            "Sign-in fills only signed-in tabs: open the site with browser_open signed_in:true.",
        ));
    }
    if !signin_secrets::available(state).await {
        return Ok(refused(
            "signin_unavailable",
            "Saved sign-ins are off on this computer. Ask the user to sign in in the tab, then call browser_wait_for_user.",
        ));
    }
    let site =
        butler_runtime::browser::site_of(tab["url"].as_str().unwrap_or("")).unwrap_or_default();
    let entry = state
        .application
        .signins(AppSignInCommand::Lookup { site: site.clone() })
        .await?;
    let entry = &entry["entry"];
    if entry.is_null() {
        return Ok(refused(
            "no_saved_sign_in",
            "No sign-in is saved for this site. Ask the user to sign in in the tab, then call browser_wait_for_user.",
        ));
    }
    if entry["policy"] == "never" {
        return Ok(refused(
            "signin_policy_never",
            "The user does not allow Butler to sign in to this site. Ask the user to sign in in the tab.",
        ));
    }
    Ok(
        json!({"status":"ok","site":site,"entry":{"id":entry["id"],"username":entry["username"],"policy":entry["policy"]}}),
    )
}

/// Prepares the `signin.fill` frame: re-checks the entry and mints the token.
pub(super) async fn prepare(
    state: &Arc<HttpState>,
    frame: &mut Value,
    tab: &Value,
) -> Result<Option<Value>, HttpError> {
    let looked = lookup(state, tab).await?;
    if looked["status"] != "ok" {
        return Ok(Some(looked));
    }
    let id = looked["entry"]["id"].as_str().unwrap_or("");
    if frame["args"]["entry_id"].as_str() != Some(id) {
        return Ok(Some(refused(
            "signin_entry_changed",
            "Call browser_sign_in again.",
        )));
    }
    let entry = state
        .application
        .signins(AppSignInCommand::Entry { id: id.into() })
        .await?;
    let origins: Vec<String> =
        serde_json::from_value(entry["entry"]["origins"].clone()).unwrap_or_default();
    let token = uuid::Uuid::new_v4().simple().to_string();
    {
        let mut hub = state.browser.0.lock().map_err(|_| HttpError::Internal)?;
        let now = Instant::now();
        hub.fills.retain(|_, fill| fill.expires > now);
        hub.fills.insert(
            token.clone(),
            Fill {
                entry: id.into(),
                origins: origins.clone(),
                expires: now + TOKEN_TTL,
            },
        );
    }
    frame["args"] = json!({
        "entry_id": id, "username": entry["entry"]["username"], "origins": origins,
        "fill_token": token, "policy": frame["args"]["policy"],
    });
    Ok(None)
}

/// Shapes main's fill result to the closed vocabulary and writes the audit row.
pub(super) async fn finish(
    state: &Arc<HttpState>,
    frame: &Value,
    session: &str,
    result: &Value,
) -> Result<Value, HttpError> {
    if let Ok(mut hub) = state.browser.0.lock()
        && let Some(token) = frame["args"]["fill_token"].as_str()
    {
        hub.fills.remove(token);
    }
    let status = result["status"].as_str().filter(|s| RESULTS.contains(s));
    let reason = result["reason"]
        .as_str()
        .filter(|r| HUMAN_STEPS.contains(r));
    let shaped = match (status, reason) {
        (Some("user_required"), Some(reason)) => {
            json!({"status":"user_required","reason":reason,"tab":frame["tab"],
                "recovery":"The user finishes this step in the tab; Butler waits for the hand-back."})
        }
        (Some("user_required"), None) => {
            json!({"status":"user_required","reason":"unknown_form","tab":frame["tab"]})
        }
        (Some(status), _) => json!({"status":status,"tab":frame["tab"],"url":result["url"]}),
        _ => {
            json!({"status":result["status"].as_str().filter(|s| *s == "unknown").unwrap_or("not_dispatched"),
            "reason":result["reason"].as_str().filter(|r| r.len() <= 48).unwrap_or("fill_failed"),"tab":frame["tab"]})
        }
    };
    let origin = result["url"]
        .as_str()
        .and_then(|url| url::Url::parse(url).ok())
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_default();
    let outcome = match (shaped["status"].as_str(), shaped["reason"].as_str()) {
        (Some("user_required"), Some(reason)) => format!("user_required:{reason}"),
        (Some(status), Some(reason)) => format!("{status}:{reason}"),
        (Some(status), None) => status.to_owned(),
        _ => "unknown".into(),
    };
    state
        .application
        .signins(AppSignInCommand::Audit {
            entry_id: frame["args"]["entry_id"].as_str().unwrap_or("").into(),
            session: session.into(),
            turn: frame["turn_id"].as_str().unwrap_or("").into(),
            origin,
            result: outcome,
        })
        .await?;
    Ok(shaped)
}

/// `POST /internal/browser-host/credentials/{token}` from main: single use,
/// 10 s, and only for a top-level origin the entry names.
pub(super) async fn credentials(
    state: Arc<HttpState>,
    token: &str,
    body: &Value,
) -> Result<Response, HttpError> {
    let fill = state
        .browser
        .0
        .lock()
        .map_err(|_| HttpError::Internal)?
        .fills
        .remove(token);
    let Some(fill) = fill.filter(|fill| fill.expires > Instant::now()) else {
        return Err(error(410, "fill_token_expired"));
    };
    let origin = body["origin"].as_str().unwrap_or("");
    if !fill.origins.iter().any(|allowed| allowed == origin) {
        return Err(error(403, "origin_mismatch"));
    }
    let secret = signin_secrets::get(&state, &fill.entry)
        .await?
        .ok_or_else(|| error(404, "signin_secret_missing"))?;
    let mut body = zeroize::Zeroizing::new(String::from("{\"password\":"));
    let quoted = zeroize::Zeroizing::new(
        serde_json::to_string(secret.expose()).map_err(|_| HttpError::Internal)?,
    );
    body.push_str(&quoted);
    body.push('}');
    let mut response = Response::new(Body::from(body.as_bytes().to_vec()));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}
