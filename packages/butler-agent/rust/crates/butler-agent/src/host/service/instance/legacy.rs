//! Refuse live processes referenced by pre-native service records.

use crate::host::service::instance_identity::process_is_alive;
use std::{fs, io, path::Path};

pub(crate) fn refuse_live_legacy_process(data_root: &Path) -> Result<(), crate::host::HostError> {
    for path in [
        data_root.join("state/services/butler-main.json"),
        data_root.join("state/butler-main-native.json"),
    ] {
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(_) => return Err("native_service_legacy_state_unreadable".into()),
        };
        let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|source| {
            crate::host::HostError::new("native_service_legacy_state_ambiguous").with_source(source)
        })?;
        // Positive and within the host's signed process ids.
        let pid = value
            .get("pid")
            .and_then(serde_json::Value::as_u64)
            .filter(|pid| *pid > 0 && i32::try_from(*pid).is_ok())
            .and_then(|pid| u32::try_from(pid).ok())
            .ok_or_else(|| "native_service_legacy_state_ambiguous".to_owned())?;
        if process_is_alive(pid)? {
            return Err(format!(
                "native_service_legacy_supervisor_pid_alive: legacy state references live PID {pid}; verify and stop the existing Butler supervisor before starting the native service"
            ).into());
        }
    }
    Ok(())
}
