//! Platform-owned App package activation after the Electron host drains its Agent.
use std::{
    ffi::OsString,
    path::Path,
    process::Command,
    time::{Duration, Instant},
};

/// Install a verified package after `parent` exits, then launch the replacement.
/// Only the installed bundle/image is replaced; the data directory is untouched.
pub fn install(
    artifact: &Path,
    executable: &Path,
    parent: u32,
    arguments: &[OsString],
) -> Result<(), String> {
    if parent == 0 || !artifact.is_absolute() || !executable.is_absolute() {
        return Err("Invalid App update paths or parent.".into());
    }
    install_platform(artifact, executable, parent, arguments)
}

fn wait_for_parent(parent: u32) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(60);
    while crate::process_control::liveness(parent) != crate::process_control::Liveness::Gone {
        if Instant::now() >= deadline {
            return Err("App did not quit for update.".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn install_platform(
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
    let staging = container.join(format!(".butler-update-{}", std::process::id()));
    crate::secure_fs::create_private_dir(&staging).map_err(|e| e.to_string())?;
    let result = activate_mac(artifact, executable, bundle, &staging, parent, arguments);
    let _ = crate::secure_fs::remove_tree(&staging);
    result
}

#[cfg(target_os = "macos")]
fn activate_mac(
    artifact: &Path,
    executable: &Path,
    bundle: &Path,
    staging: &Path,
    parent: u32,
    arguments: &[OsString],
) -> Result<(), String> {
    run(Command::new("ditto")
        .args(["-x", "-k"])
        .arg(artifact)
        .arg(staging))?;
    let candidate = staging.join("Butler.app");
    run(Command::new("codesign")
        .args(["--verify", "--deep", "--strict"])
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
        .args(["--verify", "--deep", "--strict"])
        .arg(&candidate))?;
    // Developer ID previews are signed but not notarized. Only a verified,
    // same-publisher candidate may have its download quarantine removed.
    remove_quarantine(&candidate)?;
    println!("app-update-ready");
    await_activation()?;
    wait_for_parent(parent)?;
    let backup = staging.join("previous.app");
    std::fs::rename(bundle, &backup).map_err(|e| e.to_string())?;
    if let Err(error) = std::fs::rename(&candidate, bundle) {
        let _ = std::fs::rename(&backup, bundle);
        return Err(error.to_string());
    }
    match Command::new(executable).args(arguments).spawn() {
        Ok(_) => Ok(()),
        Err(error) => {
            let _ = std::fs::rename(bundle, &candidate);
            let _ = std::fs::rename(&backup, bundle);
            let _ = Command::new(executable).args(arguments).spawn();
            Err(error.to_string())
        }
    }
}

#[cfg(target_os = "macos")]
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

#[cfg(target_os = "macos")]
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

#[cfg(target_os = "linux")]
fn install_platform(
    artifact: &Path,
    executable: &Path,
    parent: u32,
    arguments: &[OsString],
) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let appimage = std::env::var_os("APPIMAGE").map(std::path::PathBuf::from);
    println!("app-update-ready");
    await_activation()?;
    wait_for_parent(parent)?;
    if artifact.extension().is_some_and(|ext| ext == "deb") {
        run(Command::new("pkexec").args(["dpkg", "-i"]).arg(artifact))?;
        Command::new(executable)
            .args(arguments)
            .spawn()
            .map_err(|e| e.to_string())?;
    } else if let Some(image) = appimage {
        let replacement = image.with_extension("AppImage.new");
        std::fs::copy(artifact, &replacement).map_err(|e| e.to_string())?;
        std::fs::set_permissions(&replacement, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
        std::fs::rename(&replacement, &image).map_err(|e| e.to_string())?;
        Command::new(image)
            .args(arguments)
            .spawn()
            .map_err(|e| e.to_string())?;
    } else {
        return Err("AppImage installation path is unavailable.".into());
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn install_platform(_: &Path, _: &Path, _: u32, _: &[OsString]) -> Result<(), String> {
    Err("App activation is unavailable on this platform.".into())
}

fn run(command: &mut Command) -> Result<(), String> {
    let result = command.output().map_err(|e| e.to_string())?;
    if result.status.success() {
        Ok(())
    } else {
        Err(format!(
            "App package command {} failed: {}",
            command.get_program().display(),
            String::from_utf8_lossy(&result.stderr).trim()
        ))
    }
}

/// Read the host's commit signal only after its confirmation and drain succeed.
/// Closing the pipe cancels preparation without activating a package.
fn await_activation() -> Result<(), String> {
    use std::io::BufRead;
    let mut signal = String::new();
    std::io::stdin()
        .lock()
        .read_line(&mut signal)
        .map_err(|e| e.to_string())?;
    if signal.trim() == "activate" {
        Ok(())
    } else {
        Err("App update cancelled.".into())
    }
}

/// Only offer packages the currently running App can activate.
pub fn package_format() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "zip"
    }
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("APPIMAGE").is_some() {
            "appimage"
        } else {
            "deb"
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        "exe"
    }
}
