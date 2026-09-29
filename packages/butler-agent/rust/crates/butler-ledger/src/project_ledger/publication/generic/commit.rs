use std::fs;
use std::io;
use std::path::{Path, PathBuf};

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

/// Whether [`exchange`] can swap the trees atomically; otherwise promotion
/// takes the journaled [`displace`] route.
pub(super) fn atomic_exchange() -> bool {
    secure_fs::ATOMIC_EXCHANGE
}

/// Where [`displace`] keeps the canonical tree while the candidate moves in:
/// next to the candidate, so on the same volume.
fn displaced_path(candidate: &Path) -> PathBuf {
    let mut name = candidate.file_name().unwrap_or_default().to_os_string();
    name.push(".displaced");
    candidate.with_file_name(name)
}

/// Promotes `candidate` without an atomic exchange, in three renames: the
/// canonical tree moves aside, the candidate into its place, and the old tree
/// to the candidate path, where an exchange would have left it. The caller
/// journals the `displaced` state first, so [`resume_displacement`] can
/// finish a displacement a crash interrupted.
pub(super) fn displace(candidate: &Path, canonical: &Path) -> Result<(), LedgerEffectError> {
    let displaced = displaced_path(candidate);
    if present(&displaced)? {
        return Err(LedgerEffectError::Uncertain { source: None });
    }
    secure_fs::rename(canonical, &displaced).map_err(LedgerEffectError::uncertain)?;
    resume_displacement(candidate, canonical)
}

/// Finishes the renames of an interrupted [`displace`] from what is on
/// disk. Nothing moved yet (the canonical tree in place, nothing aside) is
/// left as it is; the caller compares the canonical tree to tell.
pub(super) fn resume_displacement(
    candidate: &Path,
    canonical: &Path,
) -> Result<(), LedgerEffectError> {
    let displaced = displaced_path(candidate);
    if !present(canonical)? {
        if !present(&displaced)? || !present(candidate)? {
            return Err(LedgerEffectError::Uncertain { source: None });
        }
        secure_fs::rename(candidate, canonical).map_err(LedgerEffectError::uncertain)?;
    }
    if present(&displaced)? {
        if present(candidate)? {
            return Err(LedgerEffectError::Uncertain { source: None });
        }
        secure_fs::rename(&displaced, candidate).map_err(LedgerEffectError::uncertain)?;
    }
    Ok(())
}

/// Whether an entry exists at `path` (a link is not followed).
fn present(path: &Path) -> Result<bool, LedgerEffectError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(LedgerEffectError::uncertain(error)),
    }
}

pub(super) fn remove_directory(path: &Path) -> Result<(), LedgerEffectError> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(LedgerEffectError::Uncertain { source: None }),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use super::{displace, displaced_path, resume_displacement};

    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "butler-displace-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |elapsed| elapsed.as_nanos())
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn tree(path: &Path, text: &str) {
        fs::create_dir_all(path).unwrap();
        fs::write(path.join("record"), text).unwrap();
    }

    fn text(path: &Path) -> String {
        fs::read_to_string(path.join("record")).unwrap()
    }

    // test-category: race
    #[test]
    fn displacement_promotes_the_candidate_and_finishes_after_a_crash() {
        let root = scratch("promote");
        let (canonical, candidate) = (root.join("ledger"), root.join("ledger.candidate"));
        tree(&canonical, "old");
        tree(&candidate, "new");
        displace(&candidate, &canonical).unwrap();
        // The candidate is canonical now; the old tree is where an atomic
        // exchange would have left it.
        assert_eq!(text(&canonical), "new");
        assert_eq!(text(&candidate), "old");
        assert!(!displaced_path(&candidate).exists());

        // A crash after the first rename leaves the canonical tree aside.
        let root = scratch("crash");
        let (canonical, candidate) = (root.join("ledger"), root.join("ledger.candidate"));
        tree(&canonical, "old");
        tree(&candidate, "new");
        fs::rename(&canonical, displaced_path(&candidate)).unwrap();
        resume_displacement(&candidate, &canonical).unwrap();
        assert_eq!(text(&canonical), "new");
        assert_eq!(text(&candidate), "old");

        // Nothing moved yet: the canonical tree stays.
        let root = scratch("untouched");
        let (canonical, candidate) = (root.join("ledger"), root.join("ledger.candidate"));
        tree(&canonical, "old");
        tree(&candidate, "new");
        resume_displacement(&candidate, &canonical).unwrap();
        assert_eq!(text(&canonical), "old");
        assert_eq!(text(&candidate), "new");
    }
}
