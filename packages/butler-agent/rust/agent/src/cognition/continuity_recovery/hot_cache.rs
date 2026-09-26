//! Project hot-cache writes use the source marker, lock, byte budget, and CAS.

pub(in crate::cognition) mod compact;

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};

use crate::cognition::{CognitionError, CognitionPathEnvironment, CognitionResult};
use crate::coordination::CognitionWriteLease;

use super::manifest::{ContinuityRecoveryManifest, RecoveryAfter};
use super::{ContinuityRecoveryAction, manifest, workspace};

const LOCK_STALE_AFTER: Duration = Duration::from_secs(10 * 60);

pub(super) fn project_cache_path(workspace: &Path) -> CognitionResult<PathBuf> {
    workspace::hot_cache_path(workspace)
}

pub(super) fn read_text(path: &Path) -> CognitionResult<String> {
    match fs::read(path) {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
        Err(failure) if failure.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(_) => Err(error("hot_cache_io_failed")),
    }
}

pub(super) fn replay_result(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    manifest_id: &str,
    workspace: &Path,
    rollback: bool,
) -> CognitionResult<Option<ContinuityRecoveryAction>> {
    let Some(manifest) = manifest::read(data_root, paths, manifest_id)? else {
        return Err(error("continuity_recovery_manifest_not_found"));
    };
    validate_manifest_cache(&manifest, workspace)?;
    let current_hash = sha256(read_text(Path::new(&manifest.before.path))?.as_bytes());
    let replayed = if rollback {
        manifest.status == "rolled_back" && current_hash == manifest.before.sha256
    } else {
        manifest.status == "applied"
            && manifest
                .after
                .as_ref()
                .is_some_and(|after| after.sha256 == current_hash)
    };
    if replayed {
        Ok(Some(ContinuityRecoveryAction {
            manifest: super::view(manifest)?,
            replayed: true,
        }))
    } else {
        Ok(None)
    }
}

pub(super) fn apply(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    manifest_id: &str,
    workspace: &Path,
    lock_path: &Path,
    lease: &CognitionWriteLease,
) -> CognitionResult<ContinuityRecoveryAction> {
    let mut manifest = manifest::required(data_root, paths, manifest_id)?;
    validate_manifest_cache(&manifest, workspace)?;
    let current_hash = sha256(read_text(Path::new(&manifest.before.path))?.as_bytes());
    if manifest.status == "applied"
        && manifest
            .after
            .as_ref()
            .is_some_and(|after| after.sha256 == current_hash)
    {
        return Ok(ContinuityRecoveryAction {
            manifest: super::view(manifest)?,
            replayed: true,
        });
    }
    if manifest.status != "approved" || manifest.approved_candidate_ids.is_empty() {
        return Err(error("continuity_recovery_approval_required"));
    }
    lease
        .assert_for_path(lock_path)
        .map_err(|_| error("memory_write_busy"))?;
    let cache = Path::new(&manifest.before.path);
    let _lock = lock_destination(cache)?;
    validate_destination(cache, workspace)?;
    let before_body = read_text(cache)?;
    if sha256(before_body.as_bytes()) != manifest.before.sha256 {
        return Err(error("continuity_recovery_snapshot_conflict"));
    }
    let approved = manifest
        .approved_candidate_ids
        .iter()
        .collect::<std::collections::HashSet<_>>();
    let result = (|| {
        let mut current = before_body.clone();
        for candidate in &manifest.candidates {
            if !approved.contains(&candidate.candidate_id) {
                continue;
            }
            current = append_semantic_entry(
                &current,
                cache,
                SemanticEntry {
                    project_id: &manifest.project_id,
                    manifest_id: &manifest.manifest_id,
                    session_id: &candidate.conversation_session_id,
                    candidate_id: &candidate.candidate_id,
                    body: &candidate.body,
                    created_at: &candidate.completed_at,
                },
            )?;
        }
        write_atomic(cache, &current)?;
        ensure_project_gitignore(cache)?;
        Ok(current)
    })();
    let after_body = match result {
        Ok(value) => value,
        Err(failure) => {
            let _ = write_atomic(cache, &before_body);
            return Err(failure);
        }
    };
    manifest.status = "applied".into();
    manifest.updated_at = manifest::now();
    manifest.after = Some(RecoveryAfter {
        bytes: after_body.len(),
        sha256: sha256(after_body.as_bytes()),
    });
    manifest::write(data_root, paths, &manifest)?;
    Ok(ContinuityRecoveryAction {
        manifest: super::view(manifest)?,
        replayed: false,
    })
}

pub(super) fn rollback(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    manifest_id: &str,
    workspace: &Path,
    lock_path: &Path,
    lease: &CognitionWriteLease,
) -> CognitionResult<ContinuityRecoveryAction> {
    let mut manifest = manifest::required(data_root, paths, manifest_id)?;
    validate_manifest_cache(&manifest, workspace)?;
    let cache = Path::new(&manifest.before.path);
    let current_hash = sha256(read_text(cache)?.as_bytes());
    if manifest.status == "rolled_back" && current_hash == manifest.before.sha256 {
        return Ok(ContinuityRecoveryAction {
            manifest: super::view(manifest)?,
            replayed: true,
        });
    }
    if manifest.status != "applied" || manifest.after.is_none() {
        return Err(error("continuity_recovery_not_applied"));
    }
    if manifest
        .after
        .as_ref()
        .is_some_and(|after| after.sha256 != current_hash)
    {
        return Err(error("continuity_recovery_rollback_conflict"));
    }
    lease
        .assert_for_path(lock_path)
        .map_err(|_| error("memory_write_busy"))?;
    let _lock = lock_destination(cache)?;
    validate_destination(cache, workspace)?;
    if sha256(read_text(cache)?.as_bytes()) != current_hash {
        return Err(error("continuity_recovery_rollback_conflict"));
    }
    let bytes = STANDARD
        .decode(&manifest.before.body_base64)
        .map_err(|_| error("continuity_recovery_manifest_invalid"))?;
    let body = String::from_utf8_lossy(&bytes);
    write_atomic(cache, &body)?;
    manifest.status = "rolled_back".into();
    manifest.updated_at = manifest::now();
    manifest::write(data_root, paths, &manifest)?;
    Ok(ContinuityRecoveryAction {
        manifest: super::view(manifest)?,
        replayed: false,
    })
}

#[derive(Clone, Copy)]
struct SemanticEntry<'a> {
    project_id: &'a str,
    manifest_id: &'a str,
    session_id: &'a str,
    candidate_id: &'a str,
    body: &'a str,
    created_at: &'a str,
}

fn append_semantic_entry(
    current: &str,
    cache: &Path,
    entry: SemanticEntry<'_>,
) -> CognitionResult<String> {
    let SemanticEntry {
        project_id,
        manifest_id,
        session_id,
        candidate_id,
        body,
        created_at,
    } = entry;
    if body.trim().is_empty() {
        return Err(error("hot_cache_entry_empty"));
    }
    if body.encode_utf16().count() > 8_000 {
        return Err(error("hot_cache_entry_too_large"));
    }
    if compact::contains_secret(body) {
        return Err(error("hot_cache_secret_rejected"));
    }
    let source_id = format!("recovery_{manifest_id}_{candidate_id}");
    let marker = format!("<!-- butler-semantic:{source_id}:start -->");
    if current.contains(&marker) {
        return Ok(current.to_owned());
    }
    let block = format!(
        "{marker}\n## [{created_at}] {project_id} | {session_id}\n- source_id: {source_id}\n- scope: project\n- project_id: {project_id}\n\n{body}\n<!-- butler-semantic:{source_id}:end -->"
    );
    let trimmed = crate::public_text::trim_js_whitespace_end(current);
    let appended = if trimmed.is_empty() {
        format!("{block}\n")
    } else {
        format!("{trimmed}\n\n{block}\n")
    };
    let bounded = compact::compact_hot_cache(&appended);
    if !bounded.audit.is_empty() {
        let audit = cache.with_file_name(format!(
            "{}.audit.md",
            cache
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("hot-cache.md")
        ));
        preserve_audit(&audit, &bounded.audit)?;
    }
    Ok(bounded.body)
}

fn validate_manifest_cache(
    manifest: &ContinuityRecoveryManifest,
    workspace: &Path,
) -> CognitionResult<()> {
    let expected = project_cache_path(workspace)?;
    if Path::new(&manifest.before.path) != expected {
        return Err(error("continuity_recovery_project_binding_changed"));
    }
    Ok(())
}

fn validate_destination(cache: &Path, workspace: &Path) -> CognitionResult<()> {
    workspace::validate_hot_cache_path(cache, workspace)
}

struct DestinationLock(PathBuf);

impl Drop for DestinationLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn lock_destination(cache: &Path) -> CognitionResult<DestinationLock> {
    let parent = cache
        .parent()
        .ok_or_else(|| error("hot_cache_destination_locked"))?;
    fs::create_dir_all(parent).map_err(|_| error("hot_cache_destination_locked"))?;
    let lock = cache.with_extension("md.lock");
    match create_lock(&lock) {
        Ok(()) => Ok(DestinationLock(lock)),
        Err(failure) if failure.kind() == std::io::ErrorKind::AlreadyExists => {
            let stale = fs::metadata(&lock)
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|modified| SystemTime::now().duration_since(modified).ok())
                .is_some_and(|age| age > LOCK_STALE_AFTER);
            if !stale {
                return Err(error("hot_cache_destination_locked"));
            }
            fs::remove_file(&lock).map_err(|_| error("hot_cache_destination_locked"))?;
            create_lock(&lock).map_err(|_| error("hot_cache_destination_locked"))?;
            Ok(DestinationLock(lock))
        }
        Err(_) => Err(error("hot_cache_destination_locked")),
    }
}

fn create_lock(path: &Path) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut lock = options.open(path)?;
    writeln!(lock, "{}", std::process::id())
}

fn write_atomic(path: &Path, body: &str) -> CognitionResult<()> {
    let parent = path.parent().ok_or_else(|| error("hot_cache_io_failed"))?;
    fs::create_dir_all(parent).map_err(|_| error("hot_cache_io_failed"))?;
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| error("hot_cache_io_failed"))?;
    let temp = parent.join(format!(".{filename}.{}.tmp", uuid::Uuid::new_v4()));
    let mut created_temp = false;
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temp)
            .map_err(|_| error("hot_cache_io_failed"))?;
        created_temp = true;
        file.write_all(body.as_bytes())
            .map_err(|_| error("hot_cache_io_failed"))?;
        file.sync_all().map_err(|_| error("hot_cache_io_failed"))?;
        fs::rename(&temp, path).map_err(|_| error("hot_cache_io_failed"))
    })();
    if created_temp {
        let _ = fs::remove_file(temp);
    }
    result
}

fn ensure_project_gitignore(cache: &Path) -> CognitionResult<()> {
    let Some(parent) = cache.parent() else {
        return Err(error("hot_cache_io_failed"));
    };
    if parent.file_name().and_then(|name| name.to_str()) != Some(".butler") {
        return Ok(());
    }
    let path = parent.join(".gitignore");
    if path.exists() {
        return Ok(());
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .and_then(|mut file| file.write_all(b"*\n"))
        .map_err(|_| error("hot_cache_io_failed"))
}

fn preserve_audit(path: &Path, body: &str) -> CognitionResult<()> {
    if body.trim().is_empty() {
        return Ok(());
    }
    let current = read_text(path)?;
    if current.contains(body.trim()) {
        return Ok(());
    }
    let next = format!(
        "{}{}{}",
        crate::public_text::trim_js_whitespace_end(&current),
        if crate::public_text::trim_js_whitespace(&current).is_empty() {
            ""
        } else {
            "\n\n"
        },
        body
    );
    write_atomic(path, &next)
}

fn sha256(body: &[u8]) -> String {
    format!("{:x}", Sha256::digest(body))
}

fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
