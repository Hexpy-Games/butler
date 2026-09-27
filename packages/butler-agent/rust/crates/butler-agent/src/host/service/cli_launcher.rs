//! The user's `butler` command at `DATA/bin/butler`.
//!
//! Releases before the native cutover installed a Bun-compiled launcher there
//! that runs `$BUTLER_HOME/bin/butler.js`; that script no longer exists, so
//! every `butler ...` command failed with "Module not found". An installed
//! Butler (one with its payload manifest) repairs this path at service start:
//! it rewrites that stale launcher, or an older launcher of its own (marked by
//! [`MARKER`]), into a small script that execs the running installation. Any
//! other file is the user's and is left alone, and a development build never
//! touches the path. The first replaced stale launcher is kept as
//! `butler.previous`; an existing `butler.previous` is never overwritten.

use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use crate::host::ResolvedInstallation;

const MARKER: &str = "# butler-native-launcher v1";

/// The entrypoint the pre-native Bun launcher runs; the compiled launcher
/// embeds its name.
const STALE_ENTRYPOINT: &[u8] = b"butler.js";

/// What [`repair`] did to `DATA/bin/butler`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum LauncherRepair {
    /// No launcher was installed at `DATA/bin/butler`.
    Absent,
    /// This is not an installed Butler (no payload manifest): the launcher is
    /// not touched.
    NotInstalled,
    /// The launcher already execs this installation.
    Current,
    /// An older native launcher pointed at another installation.
    Updated,
    /// The stale pre-native launcher was replaced.
    ReplacedStale,
    /// The file is neither ours nor the stale launcher: left alone.
    Foreign,
}

/// What the file at `DATA/bin/butler` is.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Existing {
    Ours,
    Stale,
    Foreign,
}

fn classify(contents: &[u8]) -> Existing {
    if contents
        .split(|byte| *byte == b'\n')
        .nth(1)
        .is_some_and(|line| line == MARKER.as_bytes())
    {
        Existing::Ours
    } else if contents
        .windows(STALE_ENTRYPOINT.len())
        .any(|window| window == STALE_ENTRYPOINT)
    {
        Existing::Stale
    } else {
        Existing::Foreign
    }
}

/// Rewrites a stale or outdated `DATA/bin/butler` so it execs `installation`.
pub(crate) fn repair(
    data_root: &Path,
    installation: &ResolvedInstallation,
) -> std::io::Result<LauncherRepair> {
    let launcher = data_root.join("bin").join("butler");
    match fs::symlink_metadata(&launcher) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(LauncherRepair::Absent);
        }
        Err(error) => return Err(error),
    }
    if !matches!(installation.payload_provenance(), Ok(Some(_))) {
        return Ok(LauncherRepair::NotInstalled);
    }
    let existing = fs::read(&launcher)?;
    let wanted = script(data_root, installation);
    if existing == wanted.as_bytes() && is_executable(&launcher) {
        return Ok(LauncherRepair::Current);
    }
    let kind = classify(&existing);
    match kind {
        Existing::Foreign => return Ok(LauncherRepair::Foreign),
        Existing::Stale => keep_previous(&launcher)?,
        Existing::Ours => {}
    }
    write_atomic(&launcher, wanted.as_bytes())?;
    Ok(if kind == Existing::Ours {
        LauncherRepair::Updated
    } else {
        LauncherRepair::ReplacedStale
    })
}

/// Moves the stale launcher to `butler.previous` unless one is kept already
/// (then the stale launcher is simply replaced).
fn keep_previous(launcher: &Path) -> std::io::Result<()> {
    let previous = previous_path(launcher);
    match fs::symlink_metadata(&previous) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::rename(launcher, previous)
        }
        Err(error) => Err(error),
    }
}

fn script(data_root: &Path, installation: &ResolvedInstallation) -> String {
    format!(
        "#!/bin/sh\n{MARKER}\n# Managed by Butler: rewritten when the Butler service starts.\n\
         BUTLER_DATA=\"${{BUTLER_DATA:-{data}}}\"\nexport BUTLER_DATA\n\
         exec {binary} --installation-root {root} --resource-root {resources} \"$@\"\n",
        data = double_quoted(data_root),
        binary = single_quoted(installation.executable()),
        root = single_quoted(installation.root()),
        resources = single_quoted(installation.resources()),
    )
}

fn single_quoted(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

/// Escapes a path for use inside `"..."` in a POSIX shell.
fn double_quoted(path: &Path) -> String {
    let mut out = String::new();
    for character in path.to_string_lossy().chars() {
        if matches!(character, '"' | '\\' | '$' | '`') {
            out.push('\\');
        }
        out.push(character);
    }
    out
}

fn previous_path(launcher: &Path) -> PathBuf {
    launcher.with_file_name("butler.previous")
}

fn is_executable(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|metadata| metadata.permissions().mode() & 0o111 == 0o111)
}

fn write_atomic(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let staging = path.with_file_name(format!(".butler.launcher-{}", std::process::id()));
    let result = write_executable(&staging, contents).and_then(|()| fs::rename(&staging, path));
    if result.is_err() {
        let _ = fs::remove_file(&staging);
    }
    result
}

fn write_executable(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let mut file = fs::File::create(path)?;
    file.write_all(contents)?;
    file.sync_all()?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
}
