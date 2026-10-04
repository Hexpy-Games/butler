use butler_platform::secure_fs::Canonical as _;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use butler_platform::secure_fs::{self, FileMode, Writability};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::contracts::{CommitObserver, CommittedFile, GuardedPath, MutationFailure};
use super::{diff, failure};

pub(super) struct Snapshot {
    pub path: GuardedPath,
    pub exists: bool,
    pub bytes: Vec<u8>,
    pub sha256: Option<String>,
    /// The file's permission mode, on hosts that have them.
    pub mode: Option<FileMode>,
}

pub(super) struct Prepared {
    pub before: Snapshot,
    pub data: Vec<u8>,
}

pub(super) fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Whether a write may create a missing parent directory.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Parent {
    MustExist,
    CreateMissing,
}

/// Whether replacing an existing file requires the caller's expected digest.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Replacement {
    Unguarded,
    RequiresExpectedDigest,
}

pub(super) fn observe(path: GuardedPath, parent: Parent) -> Result<Snapshot, MutationFailure> {
    if parent == Parent::MustExist {
        check_parent(&path)?;
    }
    let metadata = match fs::symlink_metadata(&path.absolute) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(failure::io(Some(path.public.clone()), &error)),
    };
    let Some(metadata) = metadata else {
        return Ok(Snapshot {
            path,
            exists: false,
            bytes: Vec::new(),
            sha256: None,
            mode: None,
        });
    };
    if !metadata.file_type().is_file() {
        return Err(failure::new(
            Some(path.public.clone()),
            "target_not_regular_file",
        ));
    }
    let bytes =
        fs::read(&path.absolute).map_err(|error| failure::io(Some(path.public.clone()), &error))?;
    let mode = secure_fs::file_mode(&metadata);
    Ok(Snapshot {
        sha256: Some(sha256(&bytes)),
        path,
        exists: true,
        bytes,
        mode,
    })
}

pub(super) fn prepare(
    snapshot: Snapshot,
    data: Vec<u8>,
    expected_sha256: Option<&str>,
    replacement: Replacement,
) -> Result<Prepared, MutationFailure> {
    prepare_guard(&snapshot, expected_sha256, replacement)?;
    Ok(Prepared {
        before: snapshot,
        data,
    })
}

pub(super) fn prepare_guard(
    snapshot: &Snapshot,
    expected_sha256: Option<&str>,
    replacement: Replacement,
) -> Result<(), MutationFailure> {
    if snapshot.exists {
        if replacement == Replacement::RequiresExpectedDigest && expected_sha256.is_none() {
            return Err(failure::new(
                Some(snapshot.path.public.clone()),
                "expected_sha256_required",
            ));
        }
        if expected_sha256.is_some_and(|expected| snapshot.sha256.as_deref() != Some(expected)) {
            let mut failure = failure::new(
                Some(snapshot.path.public.clone()),
                "expected_sha256_mismatch",
            );
            failure.before_sha256 = snapshot.sha256.clone();
            failure.expected_sha256 = expected_sha256.map(str::to_owned);
            return Err(failure);
        }
    } else if let Some(expected) = expected_sha256 {
        let mut failure = failure::new(
            Some(snapshot.path.public.clone()),
            "expected_sha256_on_missing_file",
        );
        failure.expected_sha256 = Some(expected.to_owned());
        return Err(failure);
    }
    Ok(())
}

pub(super) fn ensure_parent(
    prepared: &Prepared,
    root: Option<&Path>,
) -> Result<(), MutationFailure> {
    let Some(parent) = prepared
        .before
        .path
        .absolute
        .parent()
        .filter(|parent| root.is_none_or(|root| inside_existing_parent(root, parent)))
    else {
        let mut failed = failure::new(Some(prepared.before.path.public.clone()), "io_error");
        failed.message = "The mutation parent escaped the workspace during preflight.".into();
        failed.recovery_hint = "Retry after restoring a regular parent directory.".into();
        return Err(failed);
    };
    fs::create_dir_all(parent)
        .map_err(|error| parent_failure(&prepared.before.path.public, &error))?;
    check_parent(&prepared.before.path)?;
    if root.is_some_and(|root| !inside_existing_parent(root, parent)) {
        let mut failed = failure::new(Some(prepared.before.path.public.clone()), "io_error");
        failed.message = "The mutation parent escaped the workspace during creation.".into();
        failed.recovery_hint = "Retry after restoring a regular parent directory.".into();
        return Err(failed);
    }
    Ok(())
}

fn inside_existing_parent(root: &Path, path: &Path) -> bool {
    let root = root.canonical().unwrap_or_else(|_| root.to_path_buf());
    let mut parent = path.to_path_buf();
    let mut missing = Vec::new();
    loop {
        if let Ok(real) = parent.canonical() {
            let expanded = missing
                .into_iter()
                .rev()
                .fold(real, |base: PathBuf, segment| base.join(segment));
            return expanded.starts_with(root);
        }
        let Some(name) = parent.file_name() else {
            return false;
        };
        missing.push(name.to_os_string());
        let Some(next) = parent.parent() else {
            return false;
        };
        parent = next.to_path_buf();
    }
}

fn check_parent(path: &GuardedPath) -> Result<(), MutationFailure> {
    let Some(parent) = path.absolute.parent() else {
        return Err(failure::new(Some(path.public.clone()), "io_error"));
    };
    let metadata = fs::metadata(parent).map_err(|error| parent_failure(&path.public, &error))?;
    if !metadata.is_dir() {
        return Err(failure::new(
            Some(path.public.clone()),
            "parent_directory_missing",
        ));
    }
    check_writable_parent(parent, &path.public)?;
    Ok(())
}

fn check_writable_parent(parent: &Path, public: &str) -> Result<(), MutationFailure> {
    match secure_fs::directory_writability(parent) {
        Writability::Writable => Ok(()),
        Writability::Missing => Err(failure::new(
            Some(public.to_owned()),
            "parent_directory_missing",
        )),
        Writability::Denied => Err(failure::new(
            Some(public.to_owned()),
            "parent_directory_unwritable",
        )),
        Writability::Unknown => Err(failure::new(Some(public.to_owned()), "io_error")),
    }
}

pub(super) fn ensure_existing_parent(path: &GuardedPath) -> Result<(), MutationFailure> {
    check_parent(path)
}

fn parent_failure(path: &str, error: &std::io::Error) -> MutationFailure {
    let kind = match error.kind() {
        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory => {
            "parent_directory_missing"
        }
        std::io::ErrorKind::PermissionDenied => "parent_directory_unwritable",
        _ => "io_error",
    };
    failure::new(Some(path.to_owned()), kind)
}

pub(super) fn commit(
    prepared: Prepared,
    observer: &dyn CommitObserver,
) -> Result<CommittedFile, MutationFailure> {
    verify_unchanged(&prepared)?;
    observer.before_replace(&prepared.before.path.absolute);
    let temporary = prepared.before.path.absolute.with_file_name(format!(
        "{}.butler-{}-{}.tmp",
        prepared
            .before
            .path
            .absolute
            .file_name()
            .unwrap_or_default()
            .to_string_lossy(),
        std::process::id(),
        Uuid::new_v4()
    ));
    let result = atomic_replace(&prepared, &temporary, observer);
    let cleanup_failed = match result {
        Ok(value) => value,
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
    };
    let detail = diff::changed_file(
        &prepared.before.path.public,
        &prepared.before.bytes,
        &prepared.data,
        prepared.before.origin(),
    );
    Ok(CommittedFile {
        path: prepared.before.path.public,
        created: !prepared.before.exists,
        bytes: prepared.data.len(),
        before_sha256: prepared.before.sha256,
        after_sha256: sha256(&prepared.data),
        cleanup_failed,
        changed_file: detail,
    })
}

fn verify_unchanged(prepared: &Prepared) -> Result<(), MutationFailure> {
    let path = prepared.before.path.public.clone();
    let current = observe(
        GuardedPath {
            public: path.clone(),
            absolute: prepared.before.path.absolute.clone(),
            real: prepared.before.path.real.clone(),
        },
        Parent::MustExist,
    );
    let current = match current {
        Ok(value) => value,
        Err(error) if matches!(error.error, "not_found" | "target_not_regular_file") => {
            let mut conflict = failure::new(Some(path), "external_change_conflict");
            conflict.before_sha256 = prepared.before.sha256.clone();
            return Err(conflict);
        }
        Err(error) => return Err(error),
    };
    if prepared.before.exists != current.exists
        || prepared.before.sha256 != current.sha256
        || prepared.before.mode != current.mode
    {
        let mut conflict = failure::new(Some(path), "external_change_conflict");
        conflict.before_sha256 = prepared.before.sha256.clone();
        conflict.current_sha256 = current.sha256;
        return Err(conflict);
    }
    Ok(())
}

fn atomic_replace(
    prepared: &Prepared,
    temporary: &Path,
    observer: &dyn CommitObserver,
) -> Result<bool, MutationFailure> {
    write_temporary(prepared, temporary, observer)
        .map_err(|error| mutation_io(prepared, &error))?;
    verify_unchanged(prepared)?;
    publish_temporary(prepared, temporary, observer).map_err(|error| mutation_io(prepared, &error))
}

fn write_temporary(
    prepared: &Prepared,
    temporary: &Path,
    observer: &dyn CommitObserver,
) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    if let Some(mode) = prepared.before.mode {
        secure_fs::creation_mode(&mut options, mode);
    }
    let mut file = options.open(temporary)?;
    file.write_all(&prepared.data)?;
    observer.sync_temporary(&file)
}

fn publish_temporary(
    prepared: &Prepared,
    temporary: &Path,
    observer: &dyn CommitObserver,
) -> std::io::Result<bool> {
    if prepared.before.exists {
        fs::rename(temporary, &prepared.before.path.absolute)?;
        Ok(false)
    } else {
        match observer.link(temporary, &prepared.before.path.absolute) {
            Ok(()) => {}
            Err(error) if secure_fs::hard_link_unsupported(&error) => {
                let mut options = OpenOptions::new();
                options.write(true).create_new(true);
                if let Some(mode) = prepared.before.mode {
                    secure_fs::creation_mode(&mut options, mode);
                }
                let mut destination = options.open(&prepared.before.path.absolute)?;
                destination.write_all(&prepared.data)?;
                destination.sync_all()?;
            }
            Err(error) => return Err(error),
        }
        observer.after_link(temporary);
        Ok(fs::remove_file(temporary).is_err())
    }
}

fn mutation_io(prepared: &Prepared, error: &std::io::Error) -> MutationFailure {
    let code = if !prepared.before.exists && error.kind() == std::io::ErrorKind::AlreadyExists {
        "external_change_conflict"
    } else if error.kind() == std::io::ErrorKind::PermissionDenied {
        "permission_denied"
    } else {
        "io_error"
    };
    failure::new(Some(prepared.before.path.public.clone()), code)
}

impl Snapshot {
    /// Whether the committed file existed before the commit.
    fn origin(&self) -> diff::FileOrigin {
        if self.exists {
            diff::FileOrigin::Existing
        } else {
            diff::FileOrigin::Created
        }
    }
}
