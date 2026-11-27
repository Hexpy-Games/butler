//! Owner-confirmed SSH computers and their main-managed remote service.
mod deploy;
mod edit;
pub(super) use edit::edit;
pub(super) mod environment;
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
mod remove;
mod sessions;
pub(super) use relay::{Reply, data};
pub(super) use sessions::{Link, create_session, forward, open_stream};
mod askpass;
pub(super) mod password_stash;
mod session_state;
mod ssh;
mod ssh_key;
mod ssh_password;
pub(super) use ssh_key::register as register_ssh_key;
mod store;
mod streams;
mod target;
mod transcripts;
pub(super) use session_state::{SessionStateCache, SessionStateRow, session_state_path};
pub(super) use streams::RemoteStream;

use super::{AppSetupPort, http::HttpError};
use butler_platform::secrets::ChangeLock;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

#[derive(Clone, Deserialize, Serialize)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "independent persisted computer flags"
)]
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
    #[serde(default)]
    environment: Vec<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    environment_text: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    sent_environment: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    managed_key: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    key_added: bool,
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
            object.remove("key_added");
            object.remove("sent_credential");
            object.remove("sent_environment");
            object
                .entry("environment_text")
                .or_insert_with(|| "".into());
        }
        Ok(value)
    }
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct HostInput {
    #[serde(skip)]
    identity: Option<PathBuf>,
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
    #[serde(default)]
    managed_key: bool,
    #[serde(default)]
    password_ref: Option<String>,
    name: String,
    address: String,
    port: Option<i64>,
    key_file: Option<String>,
    folder: String,
    #[serde(default)]
    model_source: ModelSource,
    #[serde(default)]
    environment: Option<Vec<environment::EnvInput>>,
    environment_text: Option<String>,
}

impl AddInput {
    fn validate(&self, has_password: bool) -> Result<(String, String), HttpError> {
        if (self.managed_key || has_password) && self.key_file.is_some() {
            return Err(HttpError::public(
                400,
                "computer_key_file_invalid",
                "Enter a valid key file.",
            ));
        }
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
    setup: &Arc<dyn AppSetupPort>,
    data: &Path,
    input: AddInput,
    password: Option<Zeroizing<String>>,
    cancel: CancellationToken,
) -> Result<Computer, HttpError> {
    let password =
        password.or_else(|| input.password_ref.as_deref().and_then(password_stash::take));
    let (name, folder) = input.validate(password.is_some())?;
    let mut target = HostInput {
        address: input.address,
        port: input.port,
        key_file: input.key_file,
        identity: None,
    };
    target.validate()?;
    let mut environment_text = input.environment_text.unwrap_or_default();
    let values =
        environment::prepare_add(&environment_text, input.environment.unwrap_or_default())?;
    normalize_environment_text(&mut environment_text);
    let records = list(data).await?;
    store::unique_name(&records, &name)?;
    let managed_key = input.managed_key || password.is_some();
    let check = ssh::host_key(&target, &records, cancel.clone()).await?;
    let install = ssh_password::Install::start(&target, &check, password, cancel.clone()).await?;
    let saved = async {
        let platform = install
            .probe(
                &target,
                &folder,
                &records,
                &check.lines,
                managed_key,
                cancel,
            )
            .await?;
        let computer = Computer {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            address: target.address.clone(),
            port: target.port.and_then(|port| u16::try_from(port).ok()),
            key_file: target.key_file.clone(),
            folder,
            os: platform.os,
            arch: platform.arch,
            glibc: platform.glibc,
            stops_on_logout: platform.stops_on_logout,
            ai_connected: false,
            model_source: input.model_source,
            sent_credential: None,
            environment: values.keys().cloned().collect(),
            environment_text,
            sent_environment: false,
            managed_key,
            key_added: install.added(),
            host_keys: check.lines.clone(),
            added_at: chrono::Utc::now().to_rfc3339(),
        };
        let id = computer.id.clone();
        let has_secrets = !values.is_empty();
        if has_secrets {
            setup.save_computer_environment(id.clone(), values).await?;
        }
        let saved = store::add(data.join("config/computers.json"), computer).await;
        if saved.is_err() && has_secrets {
            setup.delete_computer_key(id).await?;
        }
        saved
    }
    .await;
    if saved.is_err() {
        install.rollback(&target, &check).await;
    }
    saved
}

fn normalize_environment_text(text: &mut String) {
    if text.trim().is_empty() {
        text.clear();
    }
}

fn remote_error(code: &str, message: &str) -> HttpError {
    HttpError::public(422, code, message)
}

fn connection_error(stderr: &str) -> HttpError {
    if stderr.contains("Host key verification failed") {
        remote_error("host_key_changed", "This computer's host key changed.")
    } else {
        remote_error("ssh_unreachable", "Could not reach this computer.")
    }
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
        remove::delete(setup, root, &computer, version, force, cancel).await
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
    if (!computer.environment_text.is_empty()
        || !computer.environment.is_empty()
        || computer.sent_environment)
        && environment::push(setup, root, computer, cancel.clone())
            .await
            .is_err()
    {
        butler_core::diagnostic!("[remote-env] push failed computer={}", computer.id);
    }
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
