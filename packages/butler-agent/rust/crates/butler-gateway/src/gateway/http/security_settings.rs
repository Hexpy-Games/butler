//! Settings → Security routes (#229), answered only to a client on this
//! computer (see [`super::security::is_local_client`]) that also sends the
//! local admin credential in `X-Butler-Admin` (the secret in
//! `app/runtime/auth/local-admin.json`, which only the App and the CLI
//! read): a loopback connection alone may be a forwarder.
//!
//! - `GET /security`: exposure, listen addresses, LAN URLs, allowed hosts
//!   with no connection token metadata.
//! - `POST /security/pairing`: issue an eight-digit one-time pairing code.
//! - `GET /security/pairing`: status for foreground issuers.
//! - `GET`/`DELETE /security/devices[/{id}]`: list and revoke devices.
//! - `POST /security/connection-code/rotate`: a new code; the old one, its
//!   signed URLs, browser sessions and live streams stop working at once.
//! - the `security` object of `GET`/`PATCH /settings`.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use axum::response::Response;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{Client, HttpError, HttpState, json};
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
    /// Failed LAN binds, one entry per address; empty while access is off.
    bind_errors: Vec<super::listeners::BindError>,
    /// URLs other computers on the LAN can open; empty while remote access
    /// is off.
    lan_urls: Vec<String>,
    /// Extra host names the gateway answers (tunnels, reverse proxies).
    allowed_hosts: Vec<String>,
    /// Compatibility with the existing UI: always null; no token metadata.
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
    let client = local_client(request.extensions().get::<Client>())?.clone();
    match (request.method().clone(), request.uri().path()) {
        (Method::GET, "/security") => ok(view(&state)?),
        (Method::POST, "/security/pairing") => {
            let keyed = state.security.sessions().ok_or_else(code_unavailable)?;
            ok(keyed
                .sessions
                .as_ref()
                .ok_or_else(code_unavailable)?
                .issue_pairing())
        }
        (Method::GET, "/security/pairing") => {
            let keyed = state.security.sessions().ok_or_else(code_unavailable)?;
            ok(keyed
                .sessions
                .as_ref()
                .ok_or_else(code_unavailable)?
                .pairing_status())
        }
        (Method::GET, "/security/devices") => ok(state.devices.list()),
        (Method::GET, path) if path.starts_with("/security/devices/") => {
            let device = state
                .devices
                .get(path.trim_start_matches("/security/devices/"))
                .ok_or_else(|| HttpError::public(404, "device_not_found", "Device not found."))?;
            ok(device)
        }
        (Method::DELETE, "/security/devices") => {
            state.devices.revoke(None).await?;
            ok(serde_json::json!({"revoked": true}))
        }
        (Method::DELETE, path) if path.starts_with("/security/devices/") => {
            let id = path.trim_start_matches("/security/devices/");
            if uuid::Uuid::parse_str(id).is_err() {
                return Err(HttpError::public(
                    400,
                    "invalid_device_id",
                    "Invalid device ID.",
                ));
            }
            state.devices.revoke(Some(id.into())).await?;
            ok(serde_json::json!({"revoked": true}))
        }
        #[cfg(debug_assertions)]
        (Method::POST, "/security/pairing/clock") => {
            let seconds = super::query(request.uri())
                .get("seconds")
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0)
                .min(3600);
            let keyed = state.security.sessions().ok_or_else(code_unavailable)?;
            keyed
                .sessions
                .as_ref()
                .ok_or_else(code_unavailable)?
                .advance(seconds);
            state.devices.advance(seconds);
            ok(serde_json::json!({"advanced": seconds}))
        }
        (Method::POST, "/security/connection-code/rotate") => rotate(&state, client).await,
        _ => Err(HttpError::public(404, "not_found", "Route not found.")),
    }
}

/// The client, when it is on this computer and sent the local admin
/// credential; `403 loopback_required` or `403 admin_credential_required`
/// else.
pub(super) fn local_client(client: Option<&Client>) -> Result<&Client, HttpError> {
    match client {
        Some(client) if client.local && client.admin => Ok(client),
        Some(client) if client.local => Err(HttpError::public(
            403,
            "admin_credential_required",
            "Security settings need the Butler app on this computer.",
        )),
        _ => Err(HttpError::public(
            403,
            "loopback_required",
            "Security settings are only available on this computer.",
        )),
    }
}

fn view(state: &HttpState) -> Result<SecurityView, HttpError> {
    let remote = state.remote.snapshot();
    let mut bind_addresses = vec![state.remote.primary().to_string()];
    bind_addresses.extend(remote.lan_listeners.iter().map(ToString::to_string));
    let connection_code = None;
    Ok(SecurityView {
        remote_access_enabled: remote.exposure.remote_access_enabled,
        bind_addresses,
        bind_errors: remote.bind_errors,
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
/// then closes the ones opened with the old code. This internal reset
/// requires bearer authentication and revokes every device.
async fn rotate(state: &Arc<HttpState>, client: Client) -> Result<Response, HttpError> {
    if client.access != super::security::Access::Bearer {
        return Err(HttpError::public(
            403,
            "bearer_token_required",
            "Reset requires the local service credential.",
        ));
    }
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
    state.devices.revoke(None).await?;
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
    let response = ok(RotatedCode {
        code: rotated.code,
        created_at: rotated.created_at,
    })?;
    Ok(response)
}

/// Parses the `security` object of `PATCH /settings`.
/// Parses the `security` object of `PATCH /settings`, normalizing the
/// host names, before anything else in the request is applied.
pub(super) fn parse_patch(value: Value) -> Result<SecurityPatch, HttpError> {
    let mut patch: SecurityPatch = serde_json::from_value(value)
        .map_err(|_| invalid_security("Unsupported security settings."))?;
    if let Some(hosts) = patch.allowed_hosts.take() {
        patch.allowed_hosts = Some(normalized_hosts(&hosts)?);
    }
    Ok(patch)
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
        exposure.allowed_hosts = hosts;
    }
    if let Some(store) = &state.security_store {
        store.save_exposure(exposure.clone()).await?;
    }
    state.remote.apply(state, exposure);
    Ok(())
}

/// Adds `security` to a settings view for a local admin client.
pub(super) fn add_to_settings(state: &HttpState, client: Option<&Client>, settings: &mut Value) {
    let (Some(object), true) = (settings.as_object_mut(), local_client(client).is_ok()) else {
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
