//! The parent omits denials the helper's own secret walk will rediscover.
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Whether the helper's no-follow walk from the real root rediscovers a
/// denial: its first secret-named component lies below real directories only.
/// One `openat2` per distinct prefix replaces a full resolve per entry.
pub(super) struct Rediscovery<'a> {
    root: &'a Path,
    real: &'a Path,
    fd: std::os::fd::OwnedFd,
    prefixes: HashMap<PathBuf, bool>,
}

impl<'a> Rediscovery<'a> {
    pub(super) fn new(root: &'a Path, real: &'a Path) -> std::io::Result<Self> {
        use rustix::fs::{Mode, OFlags};
        let flags = OFlags::PATH | OFlags::DIRECTORY | OFlags::CLOEXEC;
        Ok(Self {
            root,
            real,
            fd: rustix::fs::open(real, flags, Mode::empty())?,
            prefixes: HashMap::new(),
        })
    }

    pub(super) fn reaches(&mut self, path: &Path) -> bool {
        let Ok(relative) = path
            .strip_prefix(self.root)
            .or_else(|_| path.strip_prefix(self.real))
        else {
            return false;
        };
        let mut prefix = PathBuf::new();
        for component in relative.components() {
            let std::path::Component::Normal(name) = component else {
                return false;
            };
            if super::super::secret_name(&name.to_string_lossy()) {
                if let Some(known) = self.prefixes.get(&prefix) {
                    return *known;
                }
                let reached = self.directory(&prefix);
                self.prefixes.insert(prefix, reached);
                return reached;
            }
            prefix.push(name);
        }
        false
    }

    fn directory(&self, prefix: &Path) -> bool {
        use rustix::fs::{Mode, OFlags, ResolveFlags};
        prefix.as_os_str().is_empty()
            || rustix::fs::openat2(
                &self.fd,
                prefix,
                OFlags::PATH | OFlags::DIRECTORY | OFlags::CLOEXEC,
                Mode::empty(),
                ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_XDEV,
            )
            .is_ok()
    }
}
