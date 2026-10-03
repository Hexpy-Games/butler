//! Platform-owned App package activation after the Electron host drains its Agent.
use std::{ffi::OsString, path::Path};
#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
use std::{
    process::Command,
    time::{Duration, Instant},
};

/// Local hostile archives and signed bundle fixtures for native E2Es.
#[cfg(feature = "test-support")]
#[path = "app_update/fixtures.rs"]
pub mod test_support;

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

#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
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
mod mac;
#[cfg(target_os = "macos")]
use mac::install as install_platform;

/// Complete a recorded packaged-App swap on startup. Other hosts need no recovery.
pub fn recover(executable: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return mac::recover(executable);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = executable;
        Ok(())
    }
}

#[cfg(target_os = "linux")]
fn install_platform(
    artifact: &Path,
    executable: &Path,
    parent: u32,
    arguments: &[OsString],
) -> Result<(), String> {
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
        replace_appimage(artifact, &image, arguments)?;
    } else {
        return Err("AppImage installation path is unavailable.".into());
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn replace_appimage(artifact: &Path, image: &Path, arguments: &[OsString]) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let replacement = crate::secure_fs::unique_temporary(image);
    let backup = crate::secure_fs::unique_temporary(image);
    let (mut replacement_created, mut backup_created) = (false, false);
    let prepared = (|| -> std::io::Result<()> {
        copy_image_new(artifact, &replacement)?;
        replacement_created = true;
        std::fs::set_permissions(&replacement, std::fs::Permissions::from_mode(0o755))?;
        match std::fs::hard_link(image, &backup) {
            Ok(()) => {}
            Err(error) if crate::secure_fs::hard_link_unsupported(&error) => {
                copy_image_new(image, &backup)?;
            }
            Err(error) => return Err(error),
        }
        backup_created = true;
        // Keep the installed pathname present throughout the replacement.
        std::fs::rename(&replacement, image)
    })();
    if let Err(error) = prepared {
        if replacement_created {
            let _ = std::fs::remove_file(&replacement);
        }
        if backup_created {
            let _ = std::fs::remove_file(&backup);
        }
        return Err(error.to_string());
    }
    if let Err(error) = Command::new(image).args(arguments).spawn() {
        std::fs::rename(&backup, image).map_err(|restore| {
            format!("App launch failed: {error}; restoration failed: {restore}; previous image retained at {}", backup.display())
        })?;
        let _ = Command::new(image).args(arguments).spawn();
        return Err(error.to_string());
    }
    let _ = std::fs::remove_file(&backup);
    Ok(())
}

#[cfg(target_os = "linux")]
fn copy_image_new(source: &Path, destination: &Path) -> std::io::Result<()> {
    let mut source = std::fs::File::open(source)?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    crate::secure_fs::owner_only(&mut options);
    let mut destination_file = options.open(destination)?;
    let result = (|| {
        std::io::copy(&mut source, &mut destination_file)?;
        destination_file.set_permissions(source.metadata()?.permissions())?;
        destination_file.sync_all()
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(destination);
    }
    result
}

#[cfg(target_os = "windows")]
#[path = "app_update/windows.rs"]
mod windows;

#[cfg(target_os = "windows")]
fn install_platform(
    artifact: &Path,
    executable: &Path,
    parent: u32,
    arguments: &[OsString],
) -> Result<(), String> {
    windows::install(artifact, executable, parent, arguments)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn install_platform(_: &Path, _: &Path, _: u32, _: &[OsString]) -> Result<(), String> {
    Err("App activation is unavailable on this platform.".into())
}

#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
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
#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
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
    #[cfg(target_os = "windows")]
    {
        "nupkg"
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        "exe"
    }
}
