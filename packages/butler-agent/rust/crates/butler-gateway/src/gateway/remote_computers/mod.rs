//! Owner-confirmed SSH computers and their main-managed remote service.
mod deploy;
mod forward;
mod live;
mod live_pump;
mod live_records;
pub(super) use live::LiveRelays;
pub(super) use live_records::names_running_turn;
mod relay;
mod sessions;
pub(super) use relay::{Reply, data};
pub(super) use sessions::{Link, create_session, forward, open_stream};
mod ssh;
mod store;
mod streams;
pub(super) use streams::RemoteStream;

use super::{AppSetupPort, SavedProviderKey, http::HttpError};
use butler_platform::secrets::ChangeLock;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct Computer {
    id: String,
    name: String,
    address: String,
    port: Option<u16>,
    key_file: Option<String>,
    folder: String,
    os: String,
    arch: String,
    glibc: Option<String>,
    stops_on_logout: bool,
    host_keys: Vec<String>,
    added_at: String,
}

impl Computer {
    pub(super) fn id(&self) -> &str {
        &self.id
    }

    pub(super) fn wire(&self) -> Result<serde_json::Value, HttpError> {
        let mut value = serde_json::to_value(self).map_err(|_| HttpError::Internal)?;
        if let Some(object) = value.as_object_mut() {
            object.remove("host_keys");
        }
        Ok(value)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct HostInput {
    address: String,
    port: Option<i64>,
    key_file: Option<String>,
}

impl HostInput {
    fn validate(&mut self) -> Result<(), HttpError> {
        self.address = self.address.trim().to_owned();
        if self.address.is_empty()
            || self.address.starts_with('-')
            || self
                .address
                .chars()
                .any(|c| c.is_whitespace() || c.is_control())
        {
            return Err(HttpError::public(
                400,
                "computer_address_invalid",
                "Enter a valid SSH address.",
            ));
        }
        if self.port.is_some_and(|port| !(1..=65535).contains(&port)) {
            return Err(HttpError::public(
                400,
                "computer_port_invalid",
                "Enter a valid SSH port.",
            ));
        }
        if self.key_file.as_ref().is_some_and(|key| {
            key.is_empty() || key.starts_with('-') || key.chars().any(char::is_control)
        }) {
            return Err(HttpError::public(
                400,
                "computer_key_file_invalid",
                "Enter a valid key file.",
            ));
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct AddInput {
    name: String,
    address: String,
    port: Option<i64>,
    key_file: Option<String>,
    folder: String,
    host_fingerprint: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SendCredential {
    pub credential_id: String,
}

impl AddInput {
    fn validate(&self) -> Result<(String, String), HttpError> {
        let name = self.name.trim().to_owned();
        if name.is_empty() {
            return Err(HttpError::public(
                400,
                "computer_name_required",
                "Enter a computer name.",
            ));
        }
        if name.chars().count() > 80 || name.chars().any(char::is_control) {
            return Err(HttpError::public(
                400,
                "computer_name_invalid",
                "Enter a valid computer name.",
            ));
        }
        let folder = self.folder.trim().to_owned();
        if folder.is_empty() || folder.chars().any(char::is_control) {
            return Err(HttpError::public(
                400,
                "computer_folder_required",
                "Enter a work folder.",
            ));
        }
        Ok((name, folder))
    }
}

pub(super) async fn list(data: &Path) -> Result<Vec<Computer>, HttpError> {
    store::read(data.join("config/computers.json")).await
}

pub(super) async fn host_key(
    data: &Path,
    mut input: HostInput,
    cancel: CancellationToken,
) -> Result<serde_json::Value, HttpError> {
    input.validate()?;
    let records = list(data).await?;
    let host = ssh::host_key(&input, &records, cancel).await?;
    Ok(match host.fingerprint {
        Some(fingerprint) => {
            serde_json::json!({"trusted": false, "fingerprint": fingerprint, "key_type": host.key_type})
        }
        None => serde_json::json!({"trusted": true}),
    })
}

pub(super) async fn add(
    data: &Path,
    input: AddInput,
    cancel: CancellationToken,
) -> Result<Computer, HttpError> {
    let (name, folder) = input.validate()?;
    let mut target = HostInput {
        address: input.address,
        port: input.port,
        key_file: input.key_file,
    };
    target.validate()?;
    let records = list(data).await?;
    store::unique_name(&records, &name)?;
    let host = ssh::host_key(&target, &records, cancel.clone()).await?;
    if host.fingerprint.is_some() && host.fingerprint != input.host_fingerprint {
        return Err(HttpError::public(
            409,
            "host_key_unconfirmed",
            "Confirm this computer's host key.",
        ));
    }
    let platform = ssh::probe(&target, &folder, &records, &host.host_keys, cancel).await?;
    let computer = Computer {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        address: target.address,
        port: target.port.and_then(|port| u16::try_from(port).ok()),
        key_file: target.key_file,
        folder,
        os: platform.os,
        arch: platform.arch,
        glibc: platform.glibc,
        stops_on_logout: platform.stops_on_logout,
        host_keys: host.host_keys,
        added_at: chrono::Utc::now().to_rfc3339(),
    };
    store::add(data.join("config/computers.json"), computer).await
}

pub(super) async fn delete(
    setup: &Arc<dyn AppSetupPort>,
    data: &Path,
    computer: &Computer,
    cancel: CancellationToken,
) -> Result<bool, HttpError> {
    let cleaned = deploy::remove(computer, cancel).await.is_ok();
    store::delete(data.join("config/computers.json"), computer.id.clone()).await?;
    setup.delete_computer_key(computer.id.clone()).await?;
    Ok(cleaned)
}

fn remote_error(code: &str, message: &str) -> HttpError {
    HttpError::public(422, code, message)
}

pub(super) async fn change(
    setup: &Arc<dyn AppSetupPort>,
    root: &std::path::Path,
    path: &str,
    start: bool,
    version: &str,
    cancel: CancellationToken,
) -> Result<serde_json::Value, HttpError> {
    let id = path
        .strip_prefix("/computers/")
        .ok_or(HttpError::Internal)?;
    let id = if start {
        id.strip_suffix("/start").ok_or(HttpError::Internal)?
    } else {
        id
    };
    if id.is_empty() || id.contains('/') {
        return Err(HttpError::public(404, "not_found", "Route not found."));
    }
    let (_lock, computer) = locked(root, id).await?;
    if start {
        let remote = connect(setup, root, version, &computer, cancel).await?;
        Ok(
            serde_json::json!({"state": if remote.started { "ready" } else { "busy" }, "version": remote.version}),
        )
    } else {
        let cleaned = delete(setup, root, &computer, cancel).await?;
        Ok(serde_json::json!({"deleted": true, "remote_cleaned": cleaned}))
    }
}

async fn locked(root: &Path, id: &str) -> Result<(ChangeLock, Computer), HttpError> {
    let lock = butler_core::configuration::lock_file_async(
        &root.join(format!("config/computers/{id}.lock")),
    )
    .await
    .map_err(|_| HttpError::Internal)?;
    let records = list(root).await?;
    let computer = records
        .into_iter()
        .find(|computer| computer.id == id)
        .ok_or_else(|| HttpError::public(404, "computer_not_found", "Computer not found."))?;
    Ok((lock, computer))
}

async fn connect(
    setup: &Arc<dyn AppSetupPort>,
    root: &Path,
    version: &str,
    computer: &Computer,
    cancel: CancellationToken,
) -> Result<deploy::RemoteState, HttpError> {
    let state = deploy::ensure_running((root, version), computer, cancel.clone()).await?;
    let identity = setup.computer_key(computer.id.clone()).await?;
    relay::unlock(computer, &identity, cancel).await?;
    Ok(state)
}

pub(super) async fn send_credential(
    setup: &Arc<dyn AppSetupPort>,
    root: &Path,
    path: &str,
    version: &str,
    key: SavedProviderKey,
    cancel: CancellationToken,
) -> Result<serde_json::Value, HttpError> {
    let id = path
        .strip_prefix("/computers/")
        .and_then(|p| p.strip_suffix("/credentials"))
        .filter(|id| !id.is_empty() && !id.contains('/'))
        .ok_or_else(|| HttpError::public(404, "not_found", "Route not found."))?;
    let (_lock, computer) = locked(root, id).await?;
    connect(setup, root, version, &computer, cancel.clone()).await?;
    let body = serde_json::json!({"provider_id": key.provider_id, "api_key": key.api_key.expose()})
        .to_string()
        .into_bytes();
    relay::data(relay::request(&computer, "POST", "/credentials", body, cancel).await?)
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub(super) struct OauthStart {
    #[serde(default)]
    kind: Option<Value>,
}

pub(super) async fn oauth_start(
    setup: &Arc<dyn AppSetupPort>,
    root: &Path,
    id: &str,
    version: &str,
    input: OauthStart,
    shutdown: CancellationToken,
) -> Result<Value, HttpError> {
    let (_lock, computer) = locked(root, id).await?;
    connect(setup, root, version, &computer, shutdown.clone()).await?;
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|_| HttpError::Internal)?;
    let port = listener
        .local_addr()
        .map_err(|_| HttpError::Internal)?
        .port();
    let mut body = json!({"force":true,"redirect_port":port});
    if let Some(kind) = input.kind {
        body["kind"] = kind;
    }
    let view = relay::data(
        relay::request(
            &computer,
            "POST",
            "/setup/oauth/start",
            body.to_string().into_bytes(),
            shutdown.clone(),
        )
        .await?,
    )?;
    if view["status"] != "pending" {
        return Ok(view);
    }
    let invalid = || {
        remote_error(
            "remote_oauth_invalid",
            "This computer returned an invalid sign-in.",
        )
    };
    let port = view["callback_port"]
        .as_u64()
        .and_then(|p| u16::try_from(p).ok())
        .ok_or_else(invalid)?;
    let flow_id = view["flow_id"].as_str().ok_or_else(invalid)?;
    let stop = forward::replace(id, flow_id, &shutdown);
    tokio::spawn(forward::serve(listener, computer, port, stop));
    Ok(view)
}

pub(super) async fn oauth_flow(
    root: &Path,
    id: &str,
    flow_id: &str,
    cancel: CancellationToken,
) -> Result<Value, HttpError> {
    let computer = list(root)
        .await?
        .into_iter()
        .find(|computer| computer.id == id)
        .ok_or_else(|| HttpError::public(404, "computer_not_found", "Computer not found."))?;
    let path = format!("/setup/oauth/{flow_id}");
    let view = relay::data(relay::request(&computer, "GET", &path, Vec::new(), cancel).await?)?;
    if view["status"] != "pending" {
        forward::stop(id, flow_id);
    }
    Ok(view)
}

pub(super) async fn oauth_cancel(
    root: &Path,
    id: &str,
    flow_id: &str,
    cancel: CancellationToken,
) -> Result<Value, HttpError> {
    let computer = list(root)
        .await?
        .into_iter()
        .find(|computer| computer.id == id)
        .ok_or_else(|| HttpError::public(404, "computer_not_found", "Computer not found."))?;
    let path = format!("/setup/oauth/{flow_id}/cancel");
    let view =
        relay::data(relay::request(&computer, "POST", &path, b"{}".to_vec(), cancel).await?)?;
    forward::stop(id, flow_id);
    Ok(view)
}
