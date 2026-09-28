//! Settings → Security routes (#229), answered only to clients on this
//! computer (see [`super::security::is_local_client`]):
//!
//! - `GET /security`: exposure, listen addresses, LAN URLs, allowed hosts
//!   and the masked connection code.
//! - `POST /security/connection-code/reveal`: the full connection code.
//! - `POST /security/connection-code/rotate`: a new code; the old one, its
//!   signed URLs, browser sessions and live streams stop working at once.
//! - the `security` object of `GET`/`PATCH /settings`.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use axum::response::Response;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{Client, HttpError, HttpState, json, security::Access};
use crate::gateway::protocol::{APP_PROTOCOL_VERSION, ApiEnvelope};
use crate::gateway::{MAX_ALLOWED_HOSTS, normalize_allowed_host};

/// The live event every open stream gets when the code rotates.
const ROTATED_EVENT: &str = "security.connection_code_rotated";

/// `GET /security`.
#[derive(Debug, Serialize)]
struct SecurityView {
    remote_access_enabled: bool,
    /// Every address the gateway listens on, loopback first.
    bind_addresses: Vec<String>,
    /// URLs other computers on the LAN can open; empty while remote access
    /// is off.
    lan_urls: Vec<String>,
    /// Extra host names the gateway answers (tunnels, reverse proxies).
    allowed_hosts: Vec<String>,
    /// The connection code, masked; `null` when local auth is off.
    connection_code: Option<ConnectionCodeView>,
}

#[derive(Debug, Serialize)]
struct ConnectionCodeView {
    /// `abcd…wxyz`.
    masked: String,
    /// When the code was created (RFC 3339), when the token file says.
    created_at: Option<String>,
}

#[derive(Debug, Serialize)]
struct RevealedCode {
    code: String,
}

#[derive(Debug, Serialize)]
struct RotatedCode {
    code: String,
    created_at: Option<String>,
}

/// The `security` object of `PATCH /settings`.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SecurityPatch {
    remote_access_enabled: Option<bool>,
    /// Replaces the list.
    allowed_hosts: Option<Vec<String>>,
}

/// The `security` object `GET`/`PATCH /settings` answer local clients.
#[derive(Debug, Serialize)]
struct SecuritySettings {
    remote_access_enabled: bool,
    allowed_hosts: Vec<String>,
}

pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    let client = local_client(request.extensions().get::<Client>().copied())?;
    match (request.method().clone(), request.uri().path()) {
        (Method::GET, "/security") => ok(view(&state).await?),
        (Method::POST, "/security/connection-code/reveal") => {
            let code = state.security.token().ok_or_else(code_unavailable)?;
            ok(RevealedCode {
                code: code.to_string(),
            })
        }
        (Method::POST, "/security/connection-code/rotate") => rotate(&state, client).await,
        _ => Err(HttpError::public(404, "not_found", "Route not found.")),
    }
}

/// The client, when it is on this computer; `403 loopback_required` else.
pub(super) fn local_client(client: Option<Client>) -> Result<Client, HttpError> {
    client.filter(|client| client.local).ok_or_else(|| {
        HttpError::public(
            403,
            "loopback_required",
            "Security settings are only available on this computer.",
        )
    })
}

async fn view(state: &HttpState) -> Result<SecurityView, HttpError> {
    let remote = state.remote.snapshot();
    let mut bind_addresses = vec![state.remote.primary().to_string()];
    bind_addresses.extend(remote.lan_listeners.iter().map(ToString::to_string));
    let connection_code = match state.security.token() {
        Some(token) => Some(ConnectionCodeView {
            masked: mask(&token),
            created_at: match &state.security_store {
                Some(store) => store.connection_code_created_at().await?,
                None => None,
            },
        }),
        None => None,
    };
    Ok(SecurityView {
        remote_access_enabled: remote.exposure.remote_access_enabled,
        bind_addresses,
        lan_urls: remote
            .lan_authorities
            .iter()
            .map(|authority| format!("http://{authority}"))
            .collect(),
        allowed_hosts: remote.exposure.allowed_hosts,
        connection_code,
    })
}

/// Stores a new code, makes it the only credential, tells open streams,
/// then closes the ones opened with the old code. A browser session that
/// rotated gets a cookie under the new key, so its own page keeps working.
async fn rotate(state: &Arc<HttpState>, client: Client) -> Result<Response, HttpError> {
    let store = state.security_store.clone().ok_or_else(|| {
        HttpError::public(
            503,
            "security_settings_unavailable",
            "Security settings are unavailable.",
        )
    })?;
    if state.security.token().is_none() {
        return Err(code_unavailable());
    }
    let _change = state.remote.changes.lock().await;
    let rotated = store.rotate_connection_code().await?;
    let old_streams = state
        .security
        .rotate(&rotated.code)
        .ok_or_else(code_unavailable)?;
    let mut payload = Map::new();
    payload.insert(
        "created_at".into(),
        rotated
            .created_at
            .clone()
            .map_or(Value::Null, Value::String),
    );
    // The old code is already gone; a lost notice only means open clients
    // learn it from their next 401.
    let _ = state
        .application
        .publish_gateway_event(ROTATED_EVENT, payload)
        .await;
    old_streams.cancel();
    let mut response = ok(RotatedCode {
        code: rotated.code,
        created_at: rotated.created_at,
    })?;
    if client.access == Access::BrowserSession
        && let Some(cookie) = state.security.issue_session()
    {
        response.headers_mut().insert(header::SET_COOKIE, cookie);
    }
    Ok(response)
}

/// Parses the `security` object of `PATCH /settings`.
pub(super) fn parse_patch(value: Value) -> Result<SecurityPatch, HttpError> {
    serde_json::from_value(value).map_err(|_| invalid_security("Unsupported security settings."))
}

/// Persists the patched exposure, then binds or unbinds and answers the
/// new names, with no restart.
pub(super) async fn apply(state: &Arc<HttpState>, patch: SecurityPatch) -> Result<(), HttpError> {
    let _change = state.remote.changes.lock().await;
    let mut exposure = state.remote.snapshot().exposure;
    if let Some(enabled) = patch.remote_access_enabled {
        exposure.remote_access_enabled = enabled;
    }
    if let Some(hosts) = patch.allowed_hosts {
        exposure.allowed_hosts = normalized_hosts(&hosts)?;
    }
    if let Some(store) = &state.security_store {
        store.save_exposure(exposure.clone()).await?;
    }
    state.remote.apply(state, exposure);
    Ok(())
}

/// Adds `security` to a settings view for a local client.
pub(super) fn add_to_settings(state: &HttpState, client: Option<Client>, settings: &mut Value) {
    let (Some(object), true) = (settings.as_object_mut(), client.is_some_and(|c| c.local)) else {
        return;
    };
    let exposure = state.remote.snapshot().exposure;
    let security = SecuritySettings {
        remote_access_enabled: exposure.remote_access_enabled,
        allowed_hosts: exposure.allowed_hosts,
    };
    if let Ok(value) = serde_json::to_value(security) {
        object.insert("security".into(), value);
    }
}

fn normalized_hosts(hosts: &[String]) -> Result<Vec<String>, HttpError> {
    let mut normalized = Vec::new();
    for host in hosts {
        let host = normalize_allowed_host(host)
            .map_err(|error| invalid_security(&format!("Invalid allowed host: {error}.")))?;
        if !normalized.contains(&host) {
            normalized.push(host);
        }
    }
    if normalized.len() > MAX_ALLOWED_HOSTS {
        return Err(invalid_security("Too many allowed hosts."));
    }
    Ok(normalized)
}

/// `abcd…wxyz`: enough to recognize a code, not to use it.
fn mask(code: &str) -> String {
    let characters: Vec<char> = code.chars().collect();
    if characters.len() < 12 {
        return "…".to_owned();
    }
    let head: String = characters[..4].iter().collect();
    let tail: String = characters[characters.len() - 4..].iter().collect();
    format!("{head}…{tail}")
}

fn ok<T: Serialize>(data: T) -> Result<Response, HttpError> {
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data,
        },
    )
}

fn code_unavailable() -> HttpError {
    HttpError::public(
        503,
        "local_auth_unconfigured",
        "Butler App local auth is not configured.",
    )
}

fn invalid_security(message: &str) -> HttpError {
    HttpError::public(400, "invalid_settings_request", message)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Format pin: the masked code shows four characters at each end.
    #[test]
    fn masked_codes_keep_four_characters_at_each_end() {
        assert_eq!(mask("abcdefghijklmnopqrstuvwxyz"), "abcd…wxyz");
        assert_eq!(mask("short"), "…");
    }
}
