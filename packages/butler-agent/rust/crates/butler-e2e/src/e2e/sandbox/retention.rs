//! Bounded postmortems, serialized across nextest processes.
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};

pub const FAILURE_LIMIT: usize = 5;

pub(super) struct Directory {
    pub path: PathBuf,
    pub success: bool,
}

impl Drop for Directory {
    fn drop(&mut self) {
        if self.success && !std::thread::panicking() {
            match fs::remove_dir_all(&self.path) {
                Ok(()) => return,
                Err(error) => eprintln!(
                    "E2E sandbox cleanup failed: {}: {error}",
                    self.path.display()
                ),
            }
        }
        if let Err(error) = retain(&self.path) {
            eprintln!(
                "E2E failure retention failed: {}: {error}",
                self.path.display()
            );
            // Never leave an unbounded sandbox when retention fails.
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

fn retain(path: &Path) -> std::io::Result<()> {
    let base = path
        .parent()
        .ok_or_else(|| std::io::Error::other("no sandbox parent"))?;
    let failures = base.join("failures");
    fs::create_dir_all(&failures)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(base.join("retention.lock"))?;
    lock.lock()?;
    // Prune before publishing, so even simultaneous failures never exceed N.
    let mut previous = fs::read_dir(&failures)?.collect::<Result<Vec<_>, _>>()?;
    previous.sort_by_key(fs::DirEntry::file_name);
    let remove = previous.len().saturating_sub(FAILURE_LIMIT - 1);
    for entry in previous.into_iter().take(remove) {
        fs::remove_dir_all(entry.path())?;
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(std::io::Error::other)?
        .as_nanos();
    let name = path
        .file_name()
        .ok_or_else(|| std::io::Error::other("no sandbox name"))?;
    let kept = failures.join(format!("{stamp:039}-{}", name.to_string_lossy()));
    fs::rename(path, &kept)?;
    eprintln!(
        "E2E failure: kept {} (last {FAILURE_LIMIT} failures)",
        kept.display()
    );
    Ok(())
}
