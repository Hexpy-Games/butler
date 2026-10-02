//! Activate one verified full package with the installed Squirrel updater.
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

use std::{
    ffi::OsString,
    path::Path,
    process::{Command, Stdio},
};

pub(super) fn install(
    artifact: &Path,
    executable: &Path,
    parent: u32,
    arguments: &[OsString],
) -> Result<(), String> {
    if std::env::var("BUTLER_APP_DISABLE_SHELL_REGISTRATION").as_deref() == Ok("1") {
        return Err("Squirrel updates require shell registration.".into());
    }
    let root = executable
        .parent()
        .and_then(Path::parent)
        .ok_or("Squirrel installation is unavailable.")?;
    let updater = root.join("Update.exe");
    if !updater.is_file() {
        return Err("Install Butler with Setup before updating.".into());
    }
    let name = artifact
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid package name.")?;
    if !name.starts_with("butler-app-") || !name.ends_with("-full.nupkg") {
        return Err("Expected a full Butler Squirrel package.".into());
    }
    let feed = artifact
        .parent()
        .ok_or("Package directory unavailable.")?
        .join(format!("squirrel-feed-{}", std::process::id()));
    crate::secure_fs::create_private_dir(&feed).map_err(|e| e.to_string())?;
    let result = activate(artifact, &feed, &updater, parent, arguments);
    let _ = crate::secure_fs::remove_tree(&feed);
    result
}

fn activate(
    artifact: &Path,
    feed: &Path,
    updater: &Path,
    parent: u32,
    arguments: &[OsString],
) -> Result<(), String> {
    let name = artifact.file_name().ok_or("Package name unavailable.")?;
    let package = feed.join(name);
    std::fs::copy(artifact, &package).map_err(|e| e.to_string())?;
    // The host has reverified the manifest SHA-256. Squirrel's local RELEASES
    // uses SHA-1; derive it from those same bytes, never a mutable remote feed.
    let hash = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "(Get-FileHash -Algorithm SHA1 -LiteralPath $env:BUTLER_UPDATE_PACKAGE).Hash",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .env_remove("PSModulePath")
        .env("BUTLER_UPDATE_PACKAGE", &package)
        .output()
        .map_err(|e| e.to_string())?;
    let hash_text = String::from_utf8_lossy(&hash.stdout);
    let digest = hash_text.trim();
    if !hash.status.success()
        || digest.len() != 40
        || !digest.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("Squirrel package hash unavailable.".into());
    }
    let size = std::fs::metadata(&package)
        .map_err(|e| e.to_string())?
        .len();
    std::fs::write(
        feed.join("RELEASES"),
        format!("{digest} {} {size}\n", name.to_string_lossy()),
    )
    .map_err(|e| e.to_string())?;
    println!("app-update-ready");
    super::await_activation()?;
    super::wait_for_parent(parent)?;
    super::run(Command::new(updater).arg("--update").arg(feed))?;
    // processStart resolves the newest version with Squirrel's own comparer.
    let args = arguments
        .iter()
        .filter(|arg| !arg.to_string_lossy().starts_with("--squirrel-"))
        .map(|arg| quote_argument(&arg.to_string_lossy()))
        .collect::<Vec<_>>()
        .join(" ");
    let status = Command::new(updater)
        .args([
            "--processStart",
            "Butler.exe",
            "--process-start-args",
            &args,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("Squirrel relaunch failed.".into())
    }
}

fn quote_argument(value: &str) -> String {
    let mut output = String::from("\"");
    let mut slashes = 0;
    for ch in value.chars() {
        if ch == '\\' {
            slashes += 1;
            continue;
        }
        output.push_str(&"\\".repeat(if ch == '"' { slashes * 2 + 1 } else { slashes }));
        slashes = 0;
        output.push(ch);
    }
    output.push_str(&"\\".repeat(slashes * 2));
    output.push('"');
    output
}
