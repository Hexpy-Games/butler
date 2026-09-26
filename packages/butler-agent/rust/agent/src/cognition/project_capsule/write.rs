use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::{
    cognition::{
        CognitionError, CognitionPathEnvironment, CognitionResult,
        mutable_paths::ensure_data_authority,
    },
    coordination::CognitionWriteLease,
};

use super::{
    check_active, error,
    source::{ensure_source_authority, sources_are_current},
    types::PreparedCapsule,
};

const PROJECT_LOCK_STALE_AFTER: Duration = Duration::from_secs(10 * 60);

pub(super) struct ProjectCapsuleLock {
    data_root: PathBuf,
    path: PathBuf,
    file: Option<File>,
}

impl Drop for ProjectCapsuleLock {
    fn drop(&mut self) {
        self.file.take();
        if ensure_data_authority(&self.data_root, &[&self.path]).is_ok() {
            let _ = fs::remove_file(&self.path);
        }
    }
}

pub(super) fn project_lock_path(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    project_id: &str,
) -> PathBuf {
    paths
        .memory_root(data_root)
        .join("locks/project-capsules")
        .join(format!(
            "{}.lock",
            super::source::sanitize_project_memory_id(project_id)
        ))
}

pub(super) fn failure_log_path(data_root: &Path, paths: &CognitionPathEnvironment) -> PathBuf {
    paths
        .memory_root(data_root)
        .join("projects/.refresh-failures.jsonl")
}

pub(super) fn acquire_project_lock(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    project_id: &str,
) -> CognitionResult<ProjectCapsuleLock> {
    let path = project_lock_path(data_root, paths, project_id);
    let stale_path = unique_sidecar(&path, "stale");
    ensure_data_authority(data_root, &[&path, &stale_path])?;
    create_private_dir(
        path.parent()
            .ok_or_else(|| error("project_capsule_path_invalid"))?,
    )?;

    match create_lock_file(&path, false) {
        Ok(file) => {
            return Ok(ProjectCapsuleLock {
                data_root: data_root.to_path_buf(),
                path,
                file: Some(file),
            });
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(error("project_capsule_lock_unavailable")),
    }

    if !stale_lock(&path) {
        return Err(error("project_capsule_locked"));
    }
    ensure_data_authority(data_root, &[&path, &stale_path])?;
    fs::rename(&path, &stale_path).map_err(|_| error("project_capsule_locked"))?;
    match create_lock_file(&path, true) {
        Ok(file) => {
            let _ = fs::remove_file(&stale_path);
            Ok(ProjectCapsuleLock {
                data_root: data_root.to_path_buf(),
                path,
                file: Some(file),
            })
        }
        Err(_) => {
            let _ = fs::remove_file(&stale_path);
            Err(error("project_capsule_locked"))
        }
    }
}

pub(super) fn record_failure_best_effort(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    project_id: &str,
    phase: &'static str,
    message: &str,
) {
    let path = failure_log_path(data_root, paths);
    let Some(parent) = path.parent() else { return };
    if ensure_data_authority(data_root, &[parent, &path]).is_err()
        || create_private_dir(parent).is_err()
    {
        return;
    }
    let record = FailureRecord {
        ts: crate::js_date::format_iso_millis(super::now_epoch_ms())
            .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_owned()),
        project_id,
        phase,
        message: compact(message, 300),
    };
    let Ok(mut bytes) = serde_json::to_vec(&record) else {
        return;
    };
    bytes.push(b'\n');
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    set_private_mode(&mut options);
    if let Ok(mut file) = options.open(path) {
        let _ = file.write_all(&bytes);
        let _ = file.sync_data();
    }
}

pub(super) fn commit(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    lock_path: &Path,
    prepared: &PreparedCapsule,
    lease: &CognitionWriteLease,
    cancellation: &CancellationToken,
    deadline: i64,
) -> CognitionResult<PathBuf> {
    check_active(cancellation, deadline)?;
    lease
        .assert_for_path(lock_path)
        .map_err(CognitionError::from)?;
    ensure_source_authority(data_root, paths, &prepared.path)?;
    if !sources_are_current(
        data_root,
        paths,
        &prepared.project_id,
        &prepared.snapshot,
        cancellation,
        deadline,
    )? {
        return Err(error("memory_source_changed"));
    }
    if super::source::fingerprint(&prepared.snapshot)? != prepared.source_revision {
        return Err(error("memory_source_changed"));
    }
    check_active(cancellation, deadline)?;

    let parent = prepared
        .path
        .parent()
        .ok_or_else(|| error("project_capsule_path_invalid"))?;
    ensure_data_authority(data_root, &[parent, &prepared.path, lock_path])?;
    create_private_dir(parent)?;
    let temporary = unique_sidecar(&prepared.path, "tmp");
    ensure_data_authority(data_root, &[parent, &prepared.path, &temporary, lock_path])?;
    let write_result = write_capsule(&temporary, &prepared.body)
        .and_then(|()| {
            ensure_data_authority(data_root, &[parent, &prepared.path, &temporary, lock_path])
                .map_err(|_| std::io::Error::other("unsafe project capsule path"))?;
            fs::rename(&temporary, &prepared.path)
        })
        .and_then(|()| File::open(parent)?.sync_all());
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
        return Err(error("project_capsule_write_failed"));
    }
    Ok(prepared.path.clone())
}

fn write_capsule(path: &Path, body: &str) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    set_private_mode(&mut options);
    let mut file = options.open(path)?;
    file.write_all(body.as_bytes())?;
    file.sync_all()
}

fn create_lock_file(path: &Path, recovered: bool) -> std::io::Result<File> {
    let record = LockRecord {
        pid: std::process::id(),
        created_at: crate::js_date::format_iso_millis(super::now_epoch_ms())
            .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_owned()),
        recovered_stale_lock: recovered.then_some(true),
    };
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    set_private_mode(&mut options);
    let mut file = options.open(path)?;
    let result = (|| {
        serde_json::to_writer(&mut file, &record).map_err(std::io::Error::other)?;
        file.write_all(b"\n")?;
        file.sync_all()
    })();
    if let Err(failure) = result {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(failure);
    }
    Ok(file)
}

fn stale_lock(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    let age = metadata
        .modified()
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .unwrap_or_default();
    if age > PROJECT_LOCK_STALE_AFTER {
        return true;
    }
    let Ok(record) = fs::read_to_string(path) else {
        return false;
    };
    let Ok(record) = serde_json::from_str::<LockRecord>(&record) else {
        return false;
    };
    !process_alive(record.pid)
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    use nix::{errno::Errno, sys::signal::kill, unistd::Pid};
    let Ok(pid) = i32::try_from(pid) else {
        return true;
    };
    if pid <= 0 {
        return true;
    }
    match kill(Pid::from_raw(pid), None) {
        Err(Errno::ESRCH) => false,
        // EPERM and any other failure mean the process may exist.
        _ => true,
    }
}

#[cfg(not(unix))]
fn process_alive(_pid: u32) -> bool {
    true
}

fn unique_sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(
        ".{suffix}-{}-{}",
        std::process::id(),
        super::now_epoch_ms()
    ));
    path.with_file_name(name)
}

fn create_private_dir(path: &Path) -> CognitionResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true).mode(0o700);
        builder
            .create(path)
            .map_err(|_| error("project_capsule_write_failed"))
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(path).map_err(|_| error("project_capsule_write_failed"))
    }
}

#[cfg(unix)]
fn set_private_mode(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
}

#[cfg(not(unix))]
fn set_private_mode(_options: &mut OpenOptions) {}

fn compact(message: &str, limit: usize) -> String {
    let normalized = message
        .split(crate::public_text::is_js_whitespace)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if normalized.encode_utf16().count() <= limit {
        return normalized;
    }
    let mut result = String::new();
    for character in normalized.chars() {
        if result.encode_utf16().count() + character.len_utf16() > limit.saturating_sub(3) {
            break;
        }
        result.push(character);
    }
    result.push_str("...");
    result
}

#[derive(Serialize)]
struct FailureRecord<'a> {
    ts: String,
    #[serde(rename = "projectId")]
    project_id: &'a str,
    phase: &'static str,
    message: String,
}

#[derive(Deserialize, Serialize)]
struct LockRecord {
    pid: u32,
    created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    recovered_stale_lock: Option<bool>,
}
