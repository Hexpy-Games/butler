//! File-handle liveness fences preparation, including abandoned in-process dispatches.
use super::{helper, prepare::PolicyFile};
use crate::command_sandbox::{Invocation, InvocationLease};
use std::os::windows::fs::OpenOptionsExt;
use std::{fs, io, path::Path, sync::Arc};

pub(super) fn claim(policy: &Path) -> io::Result<Arc<InvocationLease>> {
    let path = policy.with_extension("lease");
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .share_mode(4)
        .open(&path)?;
    Ok(Arc::new(InvocationLease { _file: file, path }))
}
fn available(policy: &Path) -> io::Result<bool> {
    match fs::OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(4)
        .open(policy.with_extension("lease"))
    {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(error) if error.raw_os_error() == Some(32) => Ok(false),
        Err(error) => Err(error),
    }
}
fn reconcile_scratch(data: &Path) -> io::Result<()> {
    let root = data.join(crate::data_paths::PROJECT_WRITE_TMP);
    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    for entry in entries {
        let entry = entry?;
        let policy = data
            .join(crate::data_paths::SANDBOX_POLICIES)
            .join(entry.file_name())
            .with_extension("json");
        if !policy.exists() && available(&policy)? {
            ignore_missing(fs::remove_dir_all(entry.path()))?;
            ignore_missing(fs::remove_file(policy.with_extension("lease")))?;
        }
    }
    Ok(())
}

pub(super) fn reconcile_policies(data: &Path) -> std::io::Result<()> {
    let directory = data.join(crate::data_paths::SANDBOX_POLICIES);
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return reconcile_scratch(data);
        }
        Err(error) => return Err(error),
    };
    let scratch_root = data.join(crate::data_paths::PROJECT_WRITE_TMP);
    for entry in entries {
        if let Err(error) = reconcile_policy(entry, &scratch_root) {
            eprintln!("sandbox policy reconciliation failed: {error}");
        }
    }
    reconcile_scratch(data)
}

fn reconcile_policy(
    entry: std::io::Result<fs::DirEntry>,
    scratch_root: &Path,
) -> std::io::Result<()> {
    let entry = entry?;
    if entry.path().extension().is_some_and(|ext| ext == "lease") {
        let policy = entry.path().with_extension("json");
        if !policy.exists() && available(&policy)? {
            ignore_missing(fs::remove_file(entry.path()))?;
        }
        return Ok(());
    }
    if entry.path().extension().is_none_or(|ext| ext != "json") {
        return Ok(());
    }
    let bytes = match fs::read(entry.path()) {
        Ok(bytes) => bytes,
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound || error.raw_os_error() == Some(32) =>
        {
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    let payload: PolicyFile = match serde_json::from_slice(&bytes) {
        Ok(payload) => payload,
        Err(_) => {
            ignore_missing(fs::remove_file(entry.path()))?;
            return Ok(());
        }
    };
    if (payload.pid != std::process::id()
        && super::drive::start_time(payload.pid)? == Some(payload.started))
        || !available(&entry.path())?
    {
        return Ok(());
    }
    if let Ok(scratch) = crate::secure_fs::canonicalize(&payload.scratch)
        && scratch.parent() == Some(crate::secure_fs::canonicalize(scratch_root)?.as_path())
    {
        ignore_missing(fs::remove_dir_all(scratch))?;
    }
    ignore_missing(fs::remove_file(entry.path()))?;
    ignore_missing(fs::remove_file(entry.path().with_extension("lease")))?;
    Ok(())
}

fn ignore_missing(result: std::io::Result<()>) -> std::io::Result<()> {
    match result {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

pub(in crate::command_sandbox) fn cleanup_invocation(
    invocation: &Invocation,
) -> std::io::Result<()> {
    if invocation.program != helper()?.to_string_lossy()
        || invocation.arguments.first().map(String::as_str) != Some("--policy-file")
    {
        return Ok(());
    }
    let Some(path) = invocation.arguments.get(1).map(Path::new) else {
        return Ok(());
    };
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let payload: PolicyFile = serde_json::from_slice(&bytes)?;
    // Never remove preparation belonging to a helper which is still running.
    if payload.pid != std::process::id()
        && super::drive::start_time(payload.pid)? == Some(payload.started)
    {
        return Ok(());
    }
    ignore_missing(fs::remove_dir_all(payload.scratch))?;
    ignore_missing(fs::remove_file(path))?;
    ignore_missing(fs::remove_file(path.with_extension("lease")))
}
