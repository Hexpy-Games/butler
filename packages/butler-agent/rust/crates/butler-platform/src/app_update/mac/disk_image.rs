//! Signed disk-image admission. Unlike ZIP, the image keeps the bundle's hard
//! links, so the Agent's role aliases cost no extra download.
use super::super::run;
use std::{fs, path::Path, process::Command};

/// Copy the image's `Butler.app` into `staging`. The image is mounted only
/// after its own signature verifies and names the installed App's team.
pub(crate) fn extract(image: &Path, staging: &Path, team: Option<&str>) -> Result<(), String> {
    run(Command::new("codesign")
        .args(["--verify", "--strict", "--verbose=4"])
        .arg(image))?;
    if super::signing_team(image)?.as_deref() != team {
        return Err("App signing team changed.".into());
    }
    let volume = staging.join("volume");
    crate::secure_fs::create_private_dir(&volume).map_err(|e| e.to_string())?;
    // The verified signature covers the image bytes; skip hdiutil's second
    // checksum pass. Read-only and hidden from Finder while it is attached.
    run(Command::new("hdiutil")
        .args([
            "attach",
            "-readonly",
            "-nobrowse",
            "-noautoopen",
            "-noverify",
        ])
        .arg("-mountpoint")
        .arg(&volume)
        .arg(image))?;
    let copied = copy_bundle(&volume, staging);
    let detached = run(Command::new("hdiutil").arg("detach").arg(&volume)).or_else(|_| {
        run(Command::new("hdiutil")
            .args(["detach", "-force"])
            .arg(&volume))
    });
    copied.and(detached)?;
    fs::remove_dir(&volume).map_err(|e| e.to_string())
}

fn copy_bundle(volume: &Path, staging: &Path) -> Result<(), String> {
    let source = volume.join("Butler.app");
    // The image root may hold links (the Applications alias); only a real
    // bundle directory is copied. ditto keeps its hard links and attributes.
    let metadata =
        fs::symlink_metadata(&source).map_err(|_| "Disk image has no App bundle".to_owned())?;
    if !metadata.is_dir() {
        return Err("Disk image has no App bundle".into());
    }
    run(Command::new("ditto")
        .arg(&source)
        .arg(staging.join("Butler.app")))
}
