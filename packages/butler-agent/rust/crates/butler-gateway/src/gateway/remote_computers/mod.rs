//! Owner-confirmed SSH computers. No remote process is installed or started.
mod ssh;
mod store;

use super::http::HttpError;
use serde::{Deserialize, Serialize};
use std::path::Path;
use tokio_util::sync::CancellationToken;

#[derive(Deserialize, Serialize)]
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

pub(super) async fn delete(data: &Path, id: String) -> Result<(), HttpError> {
    store::delete(data.join("config/computers.json"), id).await
}

fn remote_error(code: &str, message: &str) -> HttpError {
    HttpError::public(422, code, message)
}
