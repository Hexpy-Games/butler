//! Owner-confirmed SSH computers and their main-managed remote service.
mod deploy;
mod edit;
pub(super) use edit::edit;
mod forward;
pub(super) use forward::{OauthStart, oauth_start};
mod live;
mod live_pump;
mod live_records;
mod memory;
mod model_sync;
pub(super) use model_sync::{ModelInput, ModelSource, update as update_model};
mod pending;
pub(super) use live::{Connection, LiveRelays};
pub(super) use live_records::names_running_turn;
pub(in crate::gateway) use pending::{
    decide as decide_pending, get as get_pending, list as list_pending,
};
mod relay;
mod sessions;
pub(super) use relay::{Reply, data};
pub(super) use sessions::{Link, create_session, forward, open_stream};
mod session_state;
mod ssh;
mod store;
mod streams;
mod transcripts;
pub(super) use session_state::{SessionStateCache, SessionStateRow, session_state_path};
pub(super) use streams::RemoteStream;

use super::{AppSetupPort, http::HttpError};
use butler_platform::secrets::ChangeLock;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use std::sync::Arc;
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
    #[serde(default)]
    pub ai_connected: bool,
    #[serde(default)]
    model_source: ModelSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sent_credential: Option<String>,
    host_keys: Vec<String>,
    added_at: String,
}

impl Computer {
    pub(super) fn model_source(&self) -> &ModelSource {
        &self.model_source
    }

    pub(super) fn id(&self) -> &str {
        &self.id
    }

    pub(super) fn name(&self) -> &str {
        &self.name
    }

    pub(super) fn wire(&self) -> Result<serde_json::Value, HttpError> {
        let mut value = serde_json::to_value(self).map_err(|_| HttpError::Internal)?;
        if let Some(object) = value.as_object_mut() {
            object.remove("host_keys");
            object.remove("sent_credential");
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
    #[serde(default)]
    pub(super) open_sign_in: bool,
    name: String,
    address: String,
    port: Option<i64>,
    key_file: Option<String>,
    folder: String,
    #[serde(default)]
    model_source: ModelSource,
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
    ssh::host_key(&input, &records, cancel).await?;
    Ok(serde_json::json!({"trusted": true}))
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
    let host_keys = ssh::host_key(&target, &records, cancel.clone()).await?;
    let platform = ssh::probe(&target, &folder, &records, &host_keys, cancel).await?;
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
        ai_connected: false,
        model_source: input.model_source,
        sent_credential: None,
        host_keys,
        added_at: chrono::Utc::now().to_rfc3339(),
    };
    store::add(data.join("config/computers.json"), computer).await
}

pub(super) async fn delete(
    setup: &Arc<dyn AppSetupPort>,
    data: &Path,
    computer: &Computer,
    version: &str,
    force: bool,
    cancel: CancellationToken,
) -> Result<bool, HttpError> {
    let reach = async {
        let installed = deploy::installed(computer, cancel.clone()).await?;
        if !installed {
            return Ok(None);
        }
        deploy::ensure_running((data, version), computer, cancel.clone()).await?;
        let identity = setup.computer_key(computer.id.clone()).await?;
        relay::unlock(computer, &identity, cancel.clone()).await?;
        session_state::request(computer, cancel.clone())
            .await
            .map(Some)
    }
    .await;
    let cleaned = match reach {
        Ok(sessions) => {
            if let Some(sessions) = sessions {
                if sessions.iter().any(SessionStateRow::has_active_turn) {
                    return Err(HttpError::public(
                        409,
                        "computer_busy",
                        "A conversation is still running on this computer.",
                    ));
                }
                let link = Link {
                    setup: setup.clone(),
                    root: data.to_path_buf(),
                    version: version.to_owned(),
                    cancel: cancel.clone(),
                    relays: None,
                };
                transcripts::final_pull(&link, computer)
                    .await
                    .map_err(|reason| {
                        butler_core::diagnostic!(
                            "[remote-transcripts] final pull failed computer={} reason={reason}",
                            computer.id
                        );
                        HttpError::public(
                            409,
                            "computer_not_synced",
                            "Couldn't bring back this computer's conversations. Try again.",
                        )
                    })?;
            }
            deploy::remove(computer, cancel).await.is_ok()
        }
        Err(_) if force => false,
        Err(_) => {
            return Err(HttpError::public(
                409,
                "computer_unreachable",
                "Couldn't reach Butler on this computer.",
            ));
        }
    };
    store::delete(data.join("config/computers.json"), computer.id.clone()).await?;
    setup.delete_computer_key(computer.id.clone()).await?;
    if let Err(error) = tokio::fs::remove_file(session_state_path(data, &computer.id)).await
        && error.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!(computer_id = %computer.id, %error, "Remote computer session state was not removed");
    }
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
    force: bool,
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
        let (remote, _) = connect(setup, root, version, &computer, cancel).await?;
        Ok(
            serde_json::json!({"state": if remote.started { "ready" } else { "busy" }, "version": remote.version}),
        )
    } else {
        let cleaned = delete(setup, root, &computer, version, force, cancel).await?;
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
) -> Result<(deploy::RemoteState, Result<(), HttpError>), HttpError> {
    let state = deploy::ensure_running((root, version), computer, cancel.clone()).await?;
    let identity = setup.computer_key(computer.id.clone()).await?;
    if pending::pull(computer, root, cancel.clone()).await.is_err() {
        butler_core::diagnostic!("[remote-instructions] pull failed computer={}", computer.id);
    }
    if let Err(error) = memory::push_copy(setup, computer, root, cancel.clone()).await {
        butler_core::diagnostic!(
            "[remote-memory] copy not handed over computer={}",
            computer.id
        );
        let _ = error;
    }
    relay::unlock(computer, &identity, cancel.clone()).await?;
    let sync = model_sync::sync(setup, root, computer, cancel.clone()).await;
    if sync.is_err() {
        butler_core::diagnostic!("[remote-model] sync failed computer={}", computer.id);
    }
    transcripts::spawn_pull(
        Link {
            setup: setup.clone(),
            root: root.to_path_buf(),
            version: version.to_owned(),
            cancel,
            relays: None,
        },
        computer.id.clone(),
    );
    Ok((state, sync))
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
    record_completed_sign_in(root, &computer, &view).await?;
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
    record_completed_sign_in(root, &computer, &view).await?;
    Ok(view)
}

async fn record_completed_sign_in(
    root: &Path,
    computer: &Computer,
    view: &Value,
) -> Result<(), HttpError> {
    if view["status"] == "completed" {
        store::update(
            root.join("config/computers.json"),
            computer.id.clone(),
            |c| {
                c.ai_connected = true;
                c.model_source = ModelSource::Chatgpt;
            },
        )
        .await?;
    }
    Ok(())
}
