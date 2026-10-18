//! Install a lazy HTTP writer for commands that run outside the service process.
use super::super::ResolvedInstallation;
use std::{ffi::OsString, io};

pub(super) fn prepare(installation: ResolvedInstallation, args: &[OsString]) -> io::Result<()> {
    let explicit = args
        .windows(2)
        .find(|pair| pair[0] == "--data")
        .map(|pair| pair[1].to_string_lossy().into_owned());
    butler_log::http::initialize_with(move || {
        let installation = installation.clone();
        let explicit = explicit.clone();
        async move {
            tokio::task::spawn_blocking(move || {
                let data = super::gateway::resolve_data(explicit.as_deref(), &installation)
                    .map_err(io::Error::other)?;
                let config = butler_gateway::gateway::producer_log_config(
                    &data.join("app-server/butler-client.sqlite"),
                )?;
                butler_log::Logger::producer(&data, config)
            })
            .await
            .map_err(io::Error::other)?
        }
    })
}
