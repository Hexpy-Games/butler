use std::fs;
use std::path::Path;

use butler_platform::secure_fs::{self, ExchangeError};

use super::contracts::LedgerEffectError;

pub(super) fn copy_root(source: &Path, target: &Path) -> Result<(), LedgerEffectError> {
    fs::create_dir_all(target).map_err(LedgerEffectError::uncertain)?;
    for entry in fs::read_dir(source).map_err(LedgerEffectError::uncertain)? {
        let entry = entry.map_err(LedgerEffectError::uncertain)?;
        let kind = entry.file_type().map_err(LedgerEffectError::uncertain)?;
        let destination = target.join(entry.file_name());
        if kind.is_dir() {
            copy_root(&entry.path(), &destination)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), destination).map_err(LedgerEffectError::uncertain)?;
        }
        // The source copyDirectory ignores directory entries that are neither
        // ordinary files nor directories, including symlinks.
    }
    Ok(())
}

pub(super) fn exchange(candidate: &Path, canonical: &Path) -> Result<(), LedgerEffectError> {
    secure_fs::exchange_directories(candidate, canonical).map_err(|error| match error {
        ExchangeError::Io(error) => LedgerEffectError::uncertain(error),
        ExchangeError::CrossDevice => LedgerEffectError::Uncertain { source: None },
        ExchangeError::Unsupported => {
            LedgerEffectError::Owner("project_ledger_atomic_exchange_unsupported")
        }
    })
}

pub(super) fn remove_directory(path: &Path) -> Result<(), LedgerEffectError> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(LedgerEffectError::Uncertain { source: None }),
    }
}
