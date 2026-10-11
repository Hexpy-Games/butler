//! App-setting and installation authority for the optional local developer log.

use std::{
    future::Future,
    io,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
};

use butler_runtime::operations::{
    DeveloperDiagnosticsSettingsPort, DeveloperLogStore, DeveloperLogWriteAuthority,
    OperationsDeveloperLogCapture,
};

use crate::host::ResolvedInstallation;

struct Settings {
    reader: butler_gateway::gateway::DiagnosticsSettingsReader,
}

impl DeveloperDiagnosticsSettingsPort for Settings {
    fn enabled(&self) -> Pin<Box<dyn Future<Output = bool> + Send + '_>> {
        let timing = crate::host::guided::command::timing::CommandTiming::new("developer_settings");
        Box::pin(async move {
            timing.mark("before_read");
            let enabled = self.reader.enabled().await;
            timing.mark(if enabled { "enabled" } else { "disabled" });
            enabled
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

pub(in crate::host) fn capture(
    data_root: PathBuf,
    database_path: PathBuf,
    installation: ResolvedInstallation,
) -> io::Result<(
    Arc<OperationsDeveloperLogCapture>,
    butler_gateway::gateway::DiagnosticsSettingsReader,
)> {
    let reader = butler_gateway::gateway::DiagnosticsSettingsReader::new(database_path)?;
    let authority = Arc::new(WriteAuthority {
        data_root: data_root.clone(),
        installation,
    });
    let capture = Arc::new(OperationsDeveloperLogCapture::new(
        Arc::new(DeveloperLogStore::new(data_root, authority)),
        Arc::new(Settings {
            reader: reader.clone(),
        }),
    ));
    Ok((capture, reader))
}
