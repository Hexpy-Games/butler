//! Local-only support bundle: operational logs and summary, no model-turn logs.

use crate::host::{HostError, ResolvedInstallation};
use butler_runtime::operations::{LogEntry, export_line, log_is_error, log_summary};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
};

pub(super) fn collect(
    root: &Path,
    installation: &ResolvedInstallation,
) -> Result<PathBuf, HostError> {
    let bundle = root
        .join("log-exports")
        .join(uuid::Uuid::new_v4().to_string());
    installation.validate_data_root(&bundle)?;
    refuse_symlink(&root.join("log-exports"))?;
    butler_platform::secure_fs::create_private_dir_all(&bundle).map_err(io)?;
    let mut entries = Vec::new();
    for name in [
        "butler-agent-service.stdout.log",
        "butler-agent-service.stderr.log",
    ] {
        let source = root.join("logs").join(name);
        refuse_symlink(&root.join("logs"))?;
        refuse_symlink(&source)?;
        let destination = bundle.join(name);
        collect_file(&source, &destination, &mut entries)?;
    }
    let manager = butler_platform::service_registration::job().is_ok_and(|job| job.reachable);
    let kind = match installation.payload_provenance()?.as_ref() {
        Some(manifest) if manifest.app_version.is_some() => "app",
        Some(_) => "standalone",
        None => "development",
    };
    let header = format!(
        "Butler diagnostic bundle\nVersion: {}\nOS: {}\nInstall kind: {kind}\nService manager present: {manager}",
        crate::host::service::diagnostics::version(installation),
        butler_platform::instance::os_release().map_err(io)?
    );
    let summary = log_summary(&header, &entries);
    write_private(&bundle.join("summary.txt"), summary.as_bytes())?;
    Ok(bundle)
}

fn collect_file(
    source: &Path,
    destination: &Path,
    entries: &mut Vec<LogEntry>,
) -> Result<(), HostError> {
    let mut output = private_file(destination)?;
    let input = match fs::File::open(source) {
        Ok(input) => input,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(io(error)),
    };
    // The export itself is complete; only summary candidates are retained in memory.
    let mut exits = std::collections::VecDeque::new();
    let mut last_error = None;
    for line in BufReader::new(input).lines() {
        let Some(line) = export_line(&line.map_err(io)?) else {
            continue;
        };
        writeln!(output, "{line}").map_err(io)?;
        if line.contains("[service-lifecycle] event=exit ") {
            exits.push_back(line.clone());
            if exits.len() > 5 {
                exits.pop_front();
            }
        }
        if log_is_error(&line) {
            last_error = Some(line);
        }
    }
    entries.extend(exits.into_iter().chain(last_error).map(|text| LogEntry {
        file: String::new(),
        text,
    }));
    Ok(())
}

fn refuse_symlink(path: &Path) -> Result<(), HostError> {
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("native_log_export_unsafe_path".into());
    }
    Ok(())
}

fn private_file(path: &Path) -> Result<fs::File, HostError> {
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    butler_platform::secure_fs::owner_only(&mut options);
    options.open(path).map_err(io)
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), HostError> {
    private_file(path)?.write_all(bytes).map_err(io)
}

fn io(source: std::io::Error) -> HostError {
    HostError::new("native_log_export_failed").with_source(source)
}
