//! The user's `butler` command at `DATA/bin/butler`.
//!
//! Releases before the native cutover installed a Bun-compiled launcher there
//! that runs `$BUTLER_HOME/bin/butler.js`; that script no longer exists, so
//! every `butler ...` command failed with "Module not found". The service
//! owns this path: at start it rewrites any launcher that is not the current
//! one into a small script that execs the running native installation. A
//! replaced foreign launcher is kept once as `butler.previous`.

use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use crate::host::ResolvedInstallation;

const MARKER: &str = "# butler-native-launcher v1";

/// What [`repair`] did to `DATA/bin/butler`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum LauncherRepair {
    /// No launcher was installed at `DATA/bin/butler`.
    Absent,
    /// The launcher already execs this installation.
    Current,
    /// An older native launcher pointed at another installation.
    Updated,
    /// A foreign (pre-native) launcher was moved to `butler.previous`.
    ReplacedForeign,
}

/// Rewrites a stale `DATA/bin/butler` so it execs `installation`.
pub(crate) fn repair(
    data_root: &Path,
    installation: &ResolvedInstallation,
) -> std::io::Result<LauncherRepair> {
    let launcher = data_root.join("bin").join("butler");
    let existing = match fs::symlink_metadata(&launcher) {
        Ok(_) => fs::read(&launcher).unwrap_or_default(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(LauncherRepair::Absent);
        }
        Err(error) => return Err(error),
    };
    let wanted = script(data_root, installation);
    if existing == wanted.as_bytes() && is_executable(&launcher) {
        return Ok(LauncherRepair::Current);
    }
    let ours = existing
        .split(|byte| *byte == b'\n')
        .nth(1)
        .is_some_and(|line| line == MARKER.as_bytes());
    if !ours {
        fs::rename(&launcher, previous_path(&launcher))?;
    }
    write_atomic(&launcher, wanted.as_bytes())?;
    Ok(if ours {
        LauncherRepair::Updated
    } else {
        LauncherRepair::ReplacedForeign
    })
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
