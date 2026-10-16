//! Platform-neutral E2E interface to the native Windows ledger.
#[cfg(windows)]
use super::super::windows::mxc::ledger::support;
use std::{
    io,
    path::{Path, PathBuf},
};
/// Test-only controls; no persistent state, native details or production switches.
pub struct WindowsLedger;
impl WindowsLedger {
    /// Runs the production admission path without creating a process container.
    pub fn admit(root: &Path, denied: &[PathBuf]) -> io::Result<()> {
        #[cfg(windows)]
        return support::admit(root, denied);
        #[cfg(not(windows))]
        {
            let _ = (root, denied);
            Err(io::Error::other("Windows required"))
        }
    }
    /// Exercises writable-root changes through the production registry.
    pub fn admit_with_roots(root: &Path, scratch: &[PathBuf]) -> io::Result<()> {
        #[cfg(windows)]
        return super::super::windows::mxc::ledger::admit(root, scratch, &[], &[]);
        #[cfg(not(windows))]
        {
            let _ = (root, scratch);
            Err(io::Error::other("Windows required"))
        }
    }
    /// Forces the same full verify used by age-based admission and post-run work.
    pub fn force_verify(root: &Path) -> io::Result<()> {
        Self::operate(root, "verify")
    }
    /// Invalidates all knowledge just like a lost notification buffer.
    pub fn inject_overflow(root: &Path) -> io::Result<()> {
        Self::operate(root, "overflow")
    }
    /// Ages verified_at past the production 120-second threshold.
    pub fn age(root: &Path) -> io::Result<()> {
        Self::operate(root, "age")
    }
    /// Drives native watcher limits or loses the replay journal in an isolated fixture.
    pub fn exercise(root: &Path, operation: &str) -> io::Result<()> {
        Self::operate(root, operation)
    }
    fn operate(root: &Path, operation: &str) -> io::Result<()> {
        #[cfg(windows)]
        return support::operate(root, operation);
        #[cfg(not(windows))]
        {
            let _ = (root, operation);
            Err(io::Error::other("Windows required"))
        }
    }
    /// Exact sparse groups currently refused by admission.
    pub fn aliases(root: &Path) -> io::Result<Vec<Vec<PathBuf>>> {
        #[cfg(windows)]
        return support::aliases(root);
        #[cfg(not(windows))]
        {
            let _ = root;
            Err(io::Error::other("Windows required"))
        }
    }
    /// Milliseconds since the last committed scan STARTED, and whether a scan is in flight.
    pub fn snapshot(root: &Path) -> io::Result<(u64, bool)> {
        #[cfg(windows)]
        return support::snapshot(root);
        #[cfg(not(windows))]
        {
            let _ = root;
            Err(io::Error::other("Windows required"))
        }
    }
    /// Pauses a background scan to verify admission waits for its fresh verdict.
    pub fn pause_verify(root: &Path, paused: bool) -> io::Result<()> {
        #[cfg(windows)]
        return support::pause(root, paused, false);
        #[cfg(not(windows))]
        {
            let _ = (root, paused);
            Err(io::Error::other("Windows required"))
        }
    }
    /// Pauses after a full scan, before queued changes and atomic replacement.
    pub fn pause_verify_commit(root: &Path, paused: bool) -> io::Result<()> {
        #[cfg(windows)]
        return support::pause(root, paused, true);
        #[cfg(not(windows))]
        {
            let _ = (root, paused);
            Err(io::Error::other("Windows required"))
        }
    }
    /// Whether the verifier has reached the deliberately paused commit barrier.
    pub fn verify_commit_paused(root: &Path) -> io::Result<bool> {
        #[cfg(windows)]
        return support::commit_paused(root);
        #[cfg(not(windows))]
        {
            let _ = root;
            Err(io::Error::other("Windows required"))
        }
    }
    /// Number of regular-file zero-access opens in the last complete full scan.
    pub fn verified_files(root: &Path) -> io::Result<usize> {
        #[cfg(windows)]
        return support::verified_files(root);
        #[cfg(not(windows))]
        {
            let _ = root;
            Err(io::Error::other("Windows required"))
        }
    }
    /// Independent fallback inventory, including both secret files and directories.
    pub fn tree(root: &Path) -> io::Result<Vec<PathBuf>> {
        #[cfg(windows)]
        return support::tree(root);
        #[cfg(not(windows))]
        {
            let _ = root;
            Err(io::Error::other("Windows required"))
        }
    }
}
