//! App-setting and installation authority for the optional local developer log.

use std::{
    future::Future,
    io,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
};

use crate::operations::{
    DeveloperDiagnosticsSettingsPort, DeveloperLogStore, DeveloperLogWriteAuthority,
    OperationsDeveloperLogCapture,
};

use super::ResolvedInstallation;

struct Settings {
    database_path: PathBuf,
}

impl DeveloperDiagnosticsSettingsPort for Settings {
    fn enabled(&self) -> Pin<Box<dyn Future<Output = bool> + Send + '_>> {
        let database_path = self.database_path.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                crate::gateway::diagnostics_enabled_readonly(&database_path)
            })
            .await
            .unwrap_or(false)
        })
    }
}

struct WriteAuthority {
    data_root: PathBuf,
    installation: ResolvedInstallation,
}

impl DeveloperLogWriteAuthority for WriteAuthority {
    fn authorize(&self, destination: &Path) -> io::Result<()> {
        let expected = self.data_root.join("app/developer-logs/model-turns.jsonl");
        let temp_name = destination
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_prefix(".model-turns.jsonl.retain-"))
            .and_then(|name| name.strip_suffix(".tmp"));
        let authorized_temp = destination.parent() == expected.parent()
            && temp_name.is_some_and(|name| uuid::Uuid::parse_str(name).is_ok());
        if destination != expected && !authorized_temp {
            return Err(denied());
        }
        let resolved = self
            .installation
            .validate_data_root(destination)
            .map_err(|_| denied())?;
        if !resolved.starts_with(&self.data_root) {
            return Err(denied());
        }
        for path in [
            self.data_root.join("app"),
            self.data_root.join("app/developer-logs"),
            destination.to_path_buf(),
        ] {
            match std::fs::symlink_metadata(path) {
                Ok(metadata) if metadata.file_type().is_symlink() => return Err(denied()),
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }
}

fn denied() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, "developer_log_path_denied")
}

pub(super) fn capture(
    data_root: PathBuf,
    database_path: PathBuf,
    installation: ResolvedInstallation,
) -> Arc<OperationsDeveloperLogCapture> {
    let authority = Arc::new(WriteAuthority {
        data_root: data_root.clone(),
        installation,
    });
    Arc::new(OperationsDeveloperLogCapture::new(
        Arc::new(DeveloperLogStore::new(data_root, authority)),
        Arc::new(Settings { database_path }),
    ))
}
