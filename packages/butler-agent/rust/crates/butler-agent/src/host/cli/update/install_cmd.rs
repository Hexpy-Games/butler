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
    let (archive, scratch) = resolve_archive(&context, source, sha256.as_deref()).await?;
    let (home, protected) = (context.home.clone(), context.protected_executables());
    let sha = sha256.clone();
    let installed = tokio::task::spawn_blocking(move || {
        home.install_and_activate(&archive, sha.as_deref(), KEEP_VERSIONS, &protected)
    })
    .await;
    // A download is deleted whatever came of the install.
    drop(scratch);
    let activated = installed
        .map_err(|error| {
            CliError::failed("install_write_failed", "the install was interrupted")
                .with_source(error)
        })?
        .map_err(|error| install_error(&error))?;
    let dir = activated.installed.dir.clone();
    let before = context.running_record();
    let service = if options.no_restart {
        json!({"wasRunning": null, "restarted": false})
    } else {
        match context.restart_if_running(&dir).await {
            Ok(service) => service,
            Err(error) => {
                let replaced = activated.switched.replaced.as_deref();
                let message = if context.restore(replaced, before.as_ref()).await {
                    format!("{}; the previous service is running again", error.message)
                } else {
                    error.message
                };
                return Err(CliError::failed("install_restart_failed", message));
            }
        }
    };
    let launchers = context.refresh_launchers();
    let mut data = activated.to_json();
    data["agentHome"] = json!(context.home.root());
    data["launchers"] = launchers;
    data["service"] = service;
    let human = format!(
        "Butler Agent {} installed{}.",
        activated.installed.version,
        super::agent::restart_note(&data["service"])
    );
    Ok((data, human))
}

/// A scratch directory for a download, outside DATA, removed when dropped.
struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A local path (or `file://` URL) to use as is, or a download to fetch into
/// a scratch directory that is deleted afterwards. A download must carry its
/// digest: nothing else vouches for it.
async fn resolve_archive(
    context: &Context,
    source: &str,
    sha256: Option<&str>,
) -> Result<(PathBuf, Option<Scratch>), CliError> {
    if source.starts_with("http://") || source.starts_with("https://") {
        let sha256 =
            sha256.ok_or_else(|| CliError::invalid("a downloaded archive needs --sha256"))?;
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos());
        let scratch = Scratch(
            std::env::temp_dir().join(format!("butler-install-{}-{nanos}", std::process::id())),
        );
        std::fs::create_dir_all(&scratch.0).map_err(|error| {
            CliError::failed(
                "archive_unavailable",
                "no scratch directory for the download",
            )
            .with_source(error)
        })?;
        let service = AgentArchiveUpdateService::new(
            context.data_root.clone(),
            context.installation.root().to_path_buf(),
            None,
        )
        .map_err(|error| install_error(&error))?;
        let fetched = service.fetch_archive(source, sha256, &scratch.0).await;
        service.close();
        let path = fetched.map_err(|error| install_error(&error))?;
        return Ok((path, Some(scratch)));
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
        Ok((path, None))
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
