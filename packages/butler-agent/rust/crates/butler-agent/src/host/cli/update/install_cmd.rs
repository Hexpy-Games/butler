//! `butler install --from ARCHIVE [--sha256 HEX]`: put an Agent archive in
//! the Agent home, make it the active version and point the launchers at it.
//!
//! This is the contract `install.sh` and the npm wrapper call on the binary
//! they extracted (see `docs/install-lifecycle.md`).

use std::path::PathBuf;
use std::process::ExitCode;

use butler_runtime::operations::{AgentArchiveUpdateService, KEEP_VERSIONS};
use serde_json::{Value, json};

use super::context::Context;
use super::report::{Output, install_error};
use super::{Options, ResolvedInstallation};
use crate::host::cli::error::CliError;

pub(super) async fn run(installation: ResolvedInstallation, options: &Options) -> ExitCode {
    let out = Output {
        command: "butler install",
        json: options.json,
        quiet: options.quiet,
    };
    match install(installation, options).await {
        Ok((data, human)) => out.ok(&data, &human),
        Err(error) => out.fail(&error),
    }
}

async fn install(
    installation: ResolvedInstallation,
    options: &Options,
) -> Result<(Value, String), CliError> {
    let source = options
        .from
        .as_deref()
        .ok_or_else(|| CliError::invalid("install requires --from ARCHIVE"))?;
    let sha256 = options
        .sha256
        .as_deref()
        .map(normalize_sha256)
        .transpose()?;
    let context = Context::open(installation, options)?;
    let archive = resolve_archive(&context, source, sha256.as_deref()).await?;
    let (home, protected) = (context.home.clone(), context.protected_executables());
    let sha = sha256.clone();
    let activated = tokio::task::spawn_blocking(move || {
        home.install_and_activate(&archive, sha.as_deref(), KEEP_VERSIONS, &protected)
    })
    .await
    .map_err(|error| {
        CliError::failed("install_write_failed", "the install was interrupted").with_source(error)
    })?
    .map_err(|error| install_error(&error))?;
    let dir = activated.installed.dir.clone();
    let launchers = context.refresh_launchers();
    let service = if options.no_restart {
        json!({"wasRunning": null, "restarted": false})
    } else {
        context.restart_if_running(&dir).await?
    };
    let mut data = activated.to_json();
    data["agentHome"] = json!(context.home.root());
    data["launchers"] = launchers;
    data["service"] = service;
    let human = format!(
        "Butler Agent {} installed{}.",
        activated.installed.version,
        if data["service"]["restarted"] == true {
            " and restarted"
        } else {
            ""
        }
    );
    Ok((data, human))
}

/// A local path (or `file://` URL) to use as is, or a download to fetch. A
/// download must carry its digest: nothing else vouches for it.
async fn resolve_archive(
    context: &Context,
    source: &str,
    sha256: Option<&str>,
) -> Result<PathBuf, CliError> {
    if source.starts_with("http://") || source.starts_with("https://") {
        let sha256 = sha256
            .ok_or_else(|| CliError::invalid("a downloaded archive needs --sha256").with_exit(2))?;
        let service = AgentArchiveUpdateService::new(
            context.data_root.clone(),
            context.installation.root().to_path_buf(),
            None,
        )
        .map_err(|error| install_error(&error))?;
        let fetched = service.fetch_archive(source, sha256).await;
        service.close();
        return fetched.map_err(|error| install_error(&error));
    }
    let path = match source.strip_prefix("file://") {
        Some(_) => url::Url::parse(source)
            .ok()
            .and_then(|url| url.to_file_path().ok())
            .ok_or_else(|| CliError::invalid("--from is not a usable file URL"))?,
        None => PathBuf::from(source),
    };
    let path = if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .map_err(|_| {
                CliError::failed(
                    "archive_unavailable",
                    "the working directory is unavailable",
                )
            })?
            .join(path)
    };
    if path.is_file() {
        Ok(path)
    } else {
        Err(CliError::failed(
            "archive_unavailable",
            "the archive does not exist",
        ))
    }
}

fn normalize_sha256(value: &str) -> Result<String, CliError> {
    let value = value.trim().to_ascii_lowercase();
    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(value)
    } else {
        Err(CliError::invalid("--sha256 must be 64 hex digits"))
    }
}
