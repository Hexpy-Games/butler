//! Platform constraints for immutable E2E installation files (never shipped).

/// Host-specific operations for disposable, per-scenario Agent installations.
pub struct FixtureInstallation;

impl FixtureInstallation {
    /// macOS proc_pidpath can report another name of a shared executable inode.
    /// Windows cannot unlink read-only hard links without changing the shared
    /// read-only attribute. Independent kernel copies avoid both problems.
    pub const HARD_LINKS: bool = !cfg!(any(target_os = "macos", windows));

    /// The command trampoline shipped beside an Agent, when this host uses one.
    pub fn command_helper() -> Option<&'static str> {
        #[cfg(target_os = "linux")]
        return Some("butler-sandbox");
        #[cfg(windows)]
        return Some("butler-sandbox.exe");
        #[cfg(not(any(target_os = "linux", windows)))]
        None
    }

    /// Shared Unix inodes must be unlinked without changing their permissions.
    /// Windows installations contain independent files whose attributes may be reset.
    pub fn remove_sandbox(path: &std::path::Path) -> std::io::Result<()> {
        #[cfg(windows)]
        return crate::secure_fs::remove_tree(path);
        #[cfg(not(windows))]
        std::fs::remove_dir_all(path)
    }

    /// Discard an unpublished staging file, including a partial Windows copy.
    pub fn remove_staging(path: &std::path::Path) -> std::io::Result<()> {
        #[cfg(windows)]
        if path.exists() {
            let mut permissions = std::fs::metadata(path)?.permissions();
            #[allow(
                clippy::permissions_set_readonly_false,
                reason = "Windows read-only attribute on an independent staging file"
            )]
            permissions.set_readonly(false);
            std::fs::set_permissions(path, permissions)?;
        }
        std::fs::remove_file(path)
    }
}
