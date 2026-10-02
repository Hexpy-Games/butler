//! Validated macOS bundle preparation and activation.
use super::{await_activation, run, wait_for_parent};
use std::{ffi::OsString, path::Path, process::Command};
pub(super) mod archive;
mod journal;

pub(super) fn install(
    artifact: &Path,
    executable: &Path,
    parent: u32,
    arguments: &[OsString],
) -> Result<(), String> {
    let bundle = executable
        .ancestors()
        .nth(3)
        .filter(|p| p.extension().is_some_and(|e| e == "app"))
        .ok_or("Installed App bundle is unavailable.")?;
    let container = bundle.parent().ok_or("App directory is unavailable.")?;
    let _lease = journal::lease(bundle)?.ok_or("Another App update is active")?;
    journal::recover(bundle)?;
    if journal::pending(bundle) {
        return Err("Another App update is active".into());
    }
    let staging = crate::secure_fs::unique_temporary(&container.join("butler-update"));
    crate::secure_fs::create_private_dir(&staging).map_err(|e| e.to_string())?;
    let result = activate_mac(artifact, executable, bundle, &staging, parent, arguments);
    if !journal::pending(bundle) {
        let _ = crate::secure_fs::remove_tree(&staging);
    }
    result
}

fn activate_mac(
    artifact: &Path,
    executable: &Path,
    bundle: &Path,
    staging: &Path,
    parent: u32,
    arguments: &[OsString],
) -> Result<(), String> {
    archive::extract(artifact, staging)?;
    let candidate = staging.join("Butler.app");
    run(Command::new("codesign")
        .args(["--verify", "--deep", "--strict", "--verbose=4"])
        .arg(&candidate))?;
    let team = |path: &Path| -> Result<Option<String>, String> {
        let result = Command::new("codesign")
            .args(["-dv", "--verbose=4"])
            .arg(path)
            .output()
            .map_err(|e| e.to_string())?;
        if !result.status.success() {
            return Err("App signature is unavailable.".into());
        }
        Ok(String::from_utf8_lossy(&result.stderr)
            .lines()
            .find_map(|line| {
                line.strip_prefix("TeamIdentifier=")
                    .filter(|team| *team != "not set")
                    .map(str::to_owned)
            }))
    };
    if team(bundle)? != team(&candidate)? {
        return Err("App signing team changed.".into());
    }
    crate::process_names::restore_archive_links(
        &candidate.join("Contents/Resources/bundled-agent/bin/butler-agent"),
    )
    .map_err(|error| error.to_string())?;
    run(Command::new("codesign")
        .args(["--verify", "--deep", "--strict", "--verbose=4"])
        .arg(&candidate))?;
    // Developer ID previews are signed but not notarized. Only a verified,
    // same-publisher candidate may have its download quarantine removed.
    remove_quarantine(&candidate)?;
    let main = candidate.join(executable.strip_prefix(bundle).map_err(|e| e.to_string())?);
    nix::unistd::access(&main, nix::unistd::AccessFlags::X_OK)
        .map_err(|_| "Updated App is not executable".to_owned())?;
    println!("app-update-ready");
    await_activation()?;
    wait_for_parent(parent)?;
    journal::activate(bundle, &candidate)?;
    match Command::new(executable).args(arguments).spawn() {
        Ok(_) => {
            journal::checkpoint("launched");
            journal::finish(bundle)
        }
        Err(error) => {
            journal::rollback(bundle)?;
            let _ = Command::new(executable).args(arguments).spawn();
            Err(error.to_string())
        }
    }
}

fn remove_quarantine(candidate: &Path) -> Result<(), String> {
    let mut permissions = Vec::new();
    let result = allow_attribute_writes(candidate, &mut permissions).and_then(|()| {
        run(Command::new("xattr")
            .args(["-dr", "com.apple.quarantine"])
            .arg(candidate))
    });
    let mut restored = Ok(());
    for (path, mode) in permissions.into_iter().rev() {
        if let Err(error) = std::fs::set_permissions(path, mode) {
            restored = Err(error.to_string());
        }
    }
    result.and(restored)
}

fn allow_attribute_writes(
    path: &Path,
    permissions: &mut Vec<(std::path::PathBuf, std::fs::Permissions)>,
) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let metadata = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if metadata.is_symlink() {
        return Ok(());
    }
    let mode = metadata.permissions();
    if mode.mode() & 0o200 == 0 {
        permissions.push((path.to_owned(), mode.clone()));
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode.mode() | 0o200))
            .map_err(|e| e.to_string())?;
    }
    if metadata.is_dir() {
        for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
            allow_attribute_writes(&entry.map_err(|e| e.to_string())?.path(), permissions)?;
        }
    }
    Ok(())
}

/// Recovery is called by the packaged native Agent before serving the App.
pub(super) fn recover(executable: &Path) -> Result<(), String> {
    if let Some(bundle) = executable
        .ancestors()
        .find(|p| p.extension().is_some_and(|e| e == "app"))
        && journal::pending(bundle)
        && let Some(_lease) = journal::lease(bundle)?
    {
        journal::recover(bundle)?;
    }
    Ok(())
}
