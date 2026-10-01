//! App endpoint discovery and security settings persistence.
use crate::host::ResolvedInstallation;
use serde_json::{Map, Value};
use std::path::PathBuf;
mod control;
mod settings;

/// Merges `patch` into `gateways/app.json` `config`, atomically and keeping
/// every other field; a missing file is created. Settings → Security saves
/// through here too.
pub(crate) async fn patch_app_config(
    data_root: &std::path::Path,
    installation: &ResolvedInstallation,
    patch: Map<String, Value>,
) -> Result<(), crate::host::HostError> {
    let mut settings = settings::Settings::read(data_root, installation)?;
    settings.patch(data_root, installation, None, patch).await
}

/// The App gateway URL of the ready service that owns `data_root`, if any.
/// A service that is still starting is waited for, up to `patience`.
pub(crate) async fn running_app_endpoint(
    data_root: &std::path::Path,
    installation: &ResolvedInstallation,
    patience: std::time::Duration,
) -> Result<Option<String>, crate::host::HostError> {
    let deadline = std::time::Instant::now() + patience;
    loop {
        let Some(record) = control::verified_instance(data_root, installation)? else {
            return Ok(None);
        };
        if record.state == "ready" || std::time::Instant::now() >= deadline {
            return Ok((record.state == "ready" && record.app_enabled)
                .then_some(record.app_endpoint)
                .flatten()
                .filter(|endpoint| !endpoint.is_empty()));
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
}

/// The data folder `--data`, `BUTLER_DATA` or `~/.butler` names, validated
/// against the installation.
pub(crate) fn resolve_data(
    explicit: Option<&str>,
    installation: &ResolvedInstallation,
) -> Result<PathBuf, crate::host::HostError> {
    let home = butler_platform::user_dirs::non_empty_home_dir()
        .ok_or_else(|| "native_home_unavailable".to_owned())?;
    let requested = explicit
        .map(expand_home_path)
        .or_else(|| {
            std::env::var_os("BUTLER_DATA")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| home.join(".butler"));
    installation
        .validate_data_root(&requested)
        .map_err(|source| {
            crate::host::HostError::new("native_path_configuration_invalid").with_source(source)
        })
}

fn expand_home_path(value: &str) -> PathBuf {
    let home = butler_platform::user_dirs::home_dir();
    match (value, home) {
        ("~", Some(home)) => home,
        (value, Some(home)) if value.starts_with("~/") => home.join(&value[2..]),
        _ => PathBuf::from(value),
    }
}

/// Process-owned memory progress is available even when the App listener is disabled.
pub(crate) async fn memory_status(
    data_root: &std::path::Path,
    installation: &ResolvedInstallation,
) -> Option<Value> {
    let record = control::verified_instance(data_root, installation).ok()??;
    crate::host::app::gateway_lifecycle::memory_status(&record)
        .await
        .ok()
}
