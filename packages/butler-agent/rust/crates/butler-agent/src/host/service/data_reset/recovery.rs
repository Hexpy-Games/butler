//! Existing reset journals recover under DATA ownership before configuration reads.
//! Without a journal, startup stays read-only through the main-port bind, then
//! acquires the instance (marking empty roots), rechecks recovery and migrates
//! ownership before credentials, logs or stores are initialized.
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
) -> Result<bool, butler_turn::btcc::BtccError> {
    let root = super::super::configuration::requested_data(explicit, home);
    let default = super::super::configuration::default_data(home);
    let installation = installation.clone();
    let (legacy, journal_seen) =
        tokio::task::spawn_blocking(move || recover_owned(&root, &default, &installation))
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
    Ok(journal_seen)
}

fn recover_owned(
    requested: &Path,
    default: &Path,
    installation: &ResolvedInstallation,
) -> io::Result<(Option<PathBuf>, bool)> {
    let root = installation
        .validate_data_root(requested)
        .map_err(io::Error::other)?;
    match fs::symlink_metadata(root.join(journal::JOURNAL)) {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return Ok((
                crate::host::runtime::storage_bootstrap::is_unsupported_legacy_data(&root)
                    .then_some(root),
                false,
            ));
        }
        Err(e) => return Err(e),
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
    super::super::data_ownership::migrate(&root, requested, default)?;
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
    Ok((None, true))
}

/// The caller holds the instance lock; no other service can publish reset intent.
pub(crate) async fn initialize_owned(
    config: &crate::host::ServiceConfiguration,
    home: &Path,
    journal_seen: bool,
) -> Result<(), butler_turn::btcc::BtccError> {
    let root = config.data_root.clone();
    let requested = config.requested_data_root.clone();
    let default = super::super::configuration::default_data(home);
    tokio::task::spawn_blocking(move || {
        // A live writer that publishes after our read-only check owns DATA.
        // Any new journal requires another start: configuration may predate reset.
        if journal::load(&root)?.is_some_and(|j| {
            !journal_seen || matches!(j.phase, Phase::Requested | Phase::RollingBack)
        })
        {
            return Err(io::Error::other(
                "Reset journal changed during startup; restart to recover before reading configuration",
            ));
        }
        super::super::data_ownership::migrate(&root, &requested, &default)
    })
    .await
    .map_err(error)?
    .map_err(error)
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
