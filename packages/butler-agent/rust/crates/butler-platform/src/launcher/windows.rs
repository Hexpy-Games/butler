//! Windows runs files by their extension; there are no execute bits.

use std::fs::Metadata;
use std::io;
use std::path::{Path, PathBuf};

pub(super) const AGENT_BINARY: &str = "butler-agent.exe";
pub(super) const STANDALONE_LAUNCHER: &str = "butler.cmd";
const PORTABLE_LAUNCHER: &[u8] = b"@echo off\r\nREM butler-native-launcher v1\r\n\"%~dp0butler-agent.exe\" --installation-root \"%~dp0.\" --resource-root \"%~dp0resources\" %*\r\n";

pub(super) fn standalone_launcher_is_expected(root: &Path) -> bool {
    let launcher = root.join(STANDALONE_LAUNCHER);
    std::fs::symlink_metadata(&launcher).is_ok_and(|metadata| {
        metadata.is_file()
            && !metadata.file_type().is_symlink()
            && metadata.len() == PORTABLE_LAUNCHER.len() as u64
    }) && std::fs::read(launcher).is_ok_and(|bytes| bytes == PORTABLE_LAUNCHER)
}

pub(super) const RELEASE_OS: &str = "windows";

const RUNNABLE_EXTENSIONS: [&str; 4] = ["exe", "com", "bat", "cmd"];

pub(super) fn mark_executable(_path: &Path) -> Option<io::Result<()>> {
    None
}

pub(super) fn is_executable(path: &Path, metadata: &Metadata) -> bool {
    metadata.is_file()
        && path.extension().is_some_and(|extension| {
            RUNNABLE_EXTENSIONS
                .iter()
                .any(|runnable| extension.eq_ignore_ascii_case(runnable))
        })
}

pub(super) fn is_runnable_by_all(_metadata: &Metadata) -> bool {
    true
}

pub(super) fn system_program_dirs() -> Vec<PathBuf> {
    Vec::new()
}

// The installer creates a hardlink, so command invocation never goes through
// cmd.exe (which expands literal percent signs in profile paths).
pub(super) fn canonical_command_executable(path: PathBuf) -> io::Result<PathBuf> {
    if !path
        .file_name()
        .is_some_and(|name| name.eq_ignore_ascii_case("butler.exe"))
    {
        return Ok(path);
    }
    let marker = path.with_file_name("butler.exe.target");
    let metadata = std::fs::symlink_metadata(&marker)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 32768 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid command binding",
        ));
    }
    let target = PathBuf::from(std::fs::read_to_string(marker)?);
    if !target.is_absolute()
        || target.file_name() != Some(std::ffi::OsStr::new(AGENT_BINARY))
        || !same_file::is_same_file(&path, &target)?
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Foreign command binding",
        ));
    }
    dunce::canonicalize(&target)
}
