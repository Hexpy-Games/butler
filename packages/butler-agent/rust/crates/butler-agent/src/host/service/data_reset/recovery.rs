//! Startup acquires DATA before credentials, instance records, logs or stores.
use super::{
    apply, cleanup,
    journal::{self, Phase, TRASH_PREFIX},
};
use crate::host::{ResolvedInstallation, service::instance};
use std::{
    fs, io,
    path::{Path, PathBuf},
};

pub(crate) async fn recover(
    explicit: Option<&str>,
    home: &Path,
    installation: &ResolvedInstallation,
) -> Result<(), butler_turn::btcc::BtccError> {
    let root = super::super::configuration::requested_data(explicit, home);
    let installation = installation.clone();
    let legacy = tokio::task::spawn_blocking(move || recover_owned(&root, &installation))
        .await
        .map_err(error)?
        .map_err(error)?;
    if let Some(root) = legacy {
        return Err(butler_turn::btcc::BtccError::relayed(
            "storage_bootstrap_failed",
            crate::host::runtime::storage_bootstrap::FreshStorageError::ExistingData(root)
                .to_string(),
        ));
    }
    Ok(())
}

fn recover_owned(root: &Path, installation: &ResolvedInstallation) -> io::Result<Option<PathBuf>> {
    let root = installation
        .validate_data_root(root)
        .map_err(io::Error::other)?;
    if !root.join(journal::JOURNAL).exists()
        && crate::host::runtime::storage_bootstrap::is_unsupported_legacy_data(&root)
    {
        return Ok(Some(root));
    }
    match fs::symlink_metadata(root.join("state")) {
        Ok(m) if !m.is_dir() || m.file_type().is_symlink() => {
            return Err(io::Error::other(
                "Reset state parent is not a real directory",
            ));
        }
        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    // A CLI start controller holds admission until this child publishes its
    // instance record. Otherwise acquire admission here. DATA ownership
    // always excludes every writer, including stopped-service settings.
    let _admission = match instance::AdmissionLock::acquire(&root, installation) {
        Ok(lock) => Some(lock),
        Err(e) if e == "service_start_admission_busy" => None,
        Err(e) => return Err(io::Error::other(e)),
    };
    let _data = instance::lock_stopped_data(&root).map_err(io::Error::other)?;
    super::super::data_ownership::migrate(&root)?;
    if let Some(mut journal) = journal::load(&root)? {
        match journal.phase {
            Phase::RollingBack | Phase::Requested => {
                journal.retried = true;
                if !apply::apply(&root, &mut journal)? {
                    journal::remove(&root)?;
                }
            }
            Phase::Failed if !journal.retried => {
                journal.retried = true;
                journal.phase = Phase::Requested;
                if !apply::apply(&root, &mut journal)? {
                    journal::remove(&root)?;
                }
            }
            Phase::Failed | Phase::Cleaned => {
                journal::remove(&root)?;
            }
            Phase::Applied => {}
        }
    }
    if journal::load(&root)?.is_some_and(|j| matches!(j.phase, Phase::Applied)) {
        super::super::configuration::local_credentials::initialize_after_reset(&root)
            .map_err(io::Error::other)?;
    }
    journal::generation(&root)?;
    Ok::<_, io::Error>(None)
}
pub(crate) async fn finish(root: PathBuf) -> Result<(), butler_turn::btcc::BtccError> {
    tokio::task::spawn_blocking(move || {
        if let Some(mut journal) = journal::load(&root)?
            && matches!(journal.phase, Phase::Requested)
        {
            apply::apply(&root, &mut journal)?;
        }
        Ok::<_, io::Error>(())
    })
    .await
    .map_err(error)?
    .map_err(error)
}
pub(crate) async fn protected_roots(
    root: PathBuf,
) -> Result<Vec<PathBuf>, butler_turn::btcc::BtccError> {
    tokio::task::spawn_blocking(move || {
        let roots = fs::read_dir(&root)?
            .map(|e| e.map(|v| v.path()))
            .collect::<io::Result<Vec<_>>>()?
            .into_iter()
            .filter(|p| {
                p.file_name()
                    .is_some_and(|v| v.to_string_lossy().starts_with(TRASH_PREFIX))
            })
            .collect();
        let journal = journal::load(&root)?;
        let cleanup_root = root.clone();
        tokio::task::spawn_blocking(move || {
            if cleanup::orphans(&cleanup_root).is_err() {
                butler_core::diagnostic!("[full-reset] orphan cleanup pending");
            }
        });
        if let Some(journal) = journal.filter(|j| matches!(j.phase, Phase::Applied)) {
            // The caller is already on the blocking pool; cleanup is detached
            // from readiness and retains its journal on a keychain/I/O failure.
            tokio::task::spawn_blocking(move || {
                if cleanup::clean(&root, journal).is_err() {
                    butler_core::diagnostic!("[full-reset] cleanup pending");
                }
            });
        }
        Ok::<_, io::Error>(roots)
    })
    .await
    .map_err(error)?
    .map_err(error)
}
fn error(e: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> butler_turn::btcc::BtccError {
    let error = e.into();
    let rollback_failed = error
        .downcast_ref::<io::Error>()
        .and_then(io::Error::get_ref)
        .is_some_and(<dyn std::error::Error + Send + Sync>::is::<apply::RollbackError>);
    let code = if rollback_failed {
        "full_reset_rollback_failed"
    } else {
        "full_reset_recovery_failed"
    };
    butler_turn::btcc::BtccError::relayed(code, error.to_string())
}
