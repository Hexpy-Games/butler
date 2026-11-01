//! One form for every path Butler resolves or compares.

use super::sys;
use std::io;
use std::path::{Path, PathBuf};

/// The absolute path of `path` with every link resolved, like
/// [`std::fs::canonicalize`], but in the form the rest of the host
/// understands: Windows returns resolved paths with the `\\?\` prefix, which
/// `cmd.exe` rejects as a working directory and which never matches a path
/// spelled without it, so the prefix is dropped wherever the path does not
/// need it. Every canonical path Butler compares or hands to a program comes
/// from here, so all of them share one form.
pub fn canonicalize(path: impl AsRef<Path>) -> io::Result<PathBuf> {
    sys::canonicalize(path.as_ref())
}

/// [`canonicalize`] as a method, in place of [`Path::canonicalize`].
pub trait Canonical {
    /// See [`canonicalize`].
    fn canonical(&self) -> io::Result<PathBuf>;
}

impl<P: AsRef<Path> + ?Sized> Canonical for P {
    fn canonical(&self) -> io::Result<PathBuf> {
        canonicalize(self)
    }
}

/// The form of `path` two paths are compared in: as is where the file system
/// is case-sensitive; on Windows lowercased with `/` separators and without
/// the `\\?\` prefix, which [`canonicalize`] keeps on a path too long to use
/// without it.
pub fn path_key(path: &Path) -> PathBuf {
    sys::path_key(path)
}

/// Whether `path` is `root` or lies beneath it, both compared as [`path_key`]s.
pub fn is_within(path: &Path, root: &Path) -> bool {
    path_key(path).starts_with(path_key(root))
}

/// Whether `left` and `right` name the same path, both compared as
/// [`path_key`]s.
pub fn same_path(left: &Path, right: &Path) -> bool {
    path_key(left) == path_key(right)
}

/// [`std::fs::canonicalize`] itself, which keeps Windows' extended-length
/// `\\?\` form on every path: for Win32 calls in this crate that must not
/// re-parse names (trailing dots or spaces, device names) or that work beyond
/// MAX_PATH, and for keys that only ever meet other keys made here. Compare
/// it with any other path only as a [`path_key`].
#[allow(
    clippy::disallowed_methods,
    reason = "the single std canonicalization behind the extended form"
)]
pub(crate) fn canonicalize_extended(path: impl AsRef<Path>) -> io::Result<PathBuf> {
    std::fs::canonicalize(path)
}
