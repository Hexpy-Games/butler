use std::fs;
use std::path::Path;

use super::contracts::LedgerEffectError;

pub(super) fn copy_root(source: &Path, target: &Path) -> Result<(), LedgerEffectError> {
    fs::create_dir_all(target).map_err(|_| LedgerEffectError::Uncertain)?;
    for entry in fs::read_dir(source).map_err(|_| LedgerEffectError::Uncertain)? {
        let entry = entry.map_err(|_| LedgerEffectError::Uncertain)?;
        let kind = entry
            .file_type()
            .map_err(|_| LedgerEffectError::Uncertain)?;
        let destination = target.join(entry.file_name());
        if kind.is_dir() {
            copy_root(&entry.path(), &destination)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), destination).map_err(|_| LedgerEffectError::Uncertain)?;
        }
        // The source copyDirectory ignores directory entries that are neither
        // ordinary files nor directories, including symlinks.
    }
    Ok(())
}

pub(super) fn exchange(candidate: &Path, canonical: &Path) -> Result<(), LedgerEffectError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let left = fs::metadata(candidate).map_err(|_| LedgerEffectError::Uncertain)?;
        let right = fs::metadata(canonical).map_err(|_| LedgerEffectError::Uncertain)?;
        if left.dev() != right.dev() {
            return Err(LedgerEffectError::Uncertain);
        }
        rustix::fs::renameat_with(
            rustix::fs::CWD,
            candidate,
            rustix::fs::CWD,
            canonical,
            rustix::fs::RenameFlags::EXCHANGE,
        )
        .map_err(|_| LedgerEffectError::Uncertain)
    }
    #[cfg(not(unix))]
    {
        let _ = (candidate, canonical);
        Err(LedgerEffectError::Owner(
            "project_ledger_atomic_exchange_unsupported",
        ))
    }
}

pub(super) fn remove_directory(path: &Path) -> Result<(), LedgerEffectError> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(LedgerEffectError::Uncertain),
    }
}
