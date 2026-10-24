//! Identity-checked client for the private same-DATA gateway control endpoint.

use butler_platform::secure_fs::Canonical as _;
use std::path::Path;

use crate::host::ResolvedInstallation;
use crate::host::service::instance::{
    DATA_BUSY, InstanceRecord, Ownership, observe, process_matches,
};

pub(super) fn verified_instance(
    data_root: &Path,
    installation: &ResolvedInstallation,
) -> Result<Option<InstanceRecord>, crate::host::HostError> {
    let Ownership { locked, record } = observe(data_root)?;
    match (locked, record) {
        (false, None) => Ok(None),
        (false, Some(record)) => {
            if process_matches(&record)? {
                Err("native_service_instance_ambiguous: live record has no DATA lock".into())
            } else {
                Ok(None)
            }
        }
        (true, Some(record)) => {
            if !matches!(record.state.as_str(), "starting" | "ready" | "stopping")
                || !process_matches(&record)?
            {
                return Err(
                    "native_service_instance_ambiguous: lock owner does not match its record"
                        .into(),
                );
            }
            let executable = butler_platform::process_names::current_exe()
                .map_err(|source| {
                    crate::host::HostError::new("native_service_executable_unavailable")
                        .with_source(source)
                })?
                .canonical()
                .map_err(|source| {
                    crate::host::HostError::new("native_service_executable_unavailable")
                        .with_source(source)
                })?;
            if !executable.starts_with(installation.root())
                || executable.to_string_lossy() != record.executable
            {
                return Err("native_service_instance_executable_mismatch".into());
            }
            Ok(Some(record))
        }
        (true, None) => Err(DATA_BUSY.into()),
    }
}

pub(super) async fn verified_instance_async(
    data_root: &Path,
    installation: &ResolvedInstallation,
) -> Result<Option<InstanceRecord>, crate::host::HostError> {
    let data_root = data_root.to_path_buf();
    let installation = installation.clone();
    tokio::task::spawn_blocking(move || verified_instance(&data_root, &installation))
        .await
        .map_err(crate::host::HostError::from_error)?
}
