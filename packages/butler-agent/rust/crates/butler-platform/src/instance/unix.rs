//! Host name and `ps` start times on Unix.

use std::io;
use std::process::Command;

pub(super) fn host_name() -> io::Result<String> {
    let name = nix::unistd::gethostname().map_err(io::Error::from)?;
    Ok(name.to_string_lossy().into_owned())
}

pub(super) fn process_started_at_ms(pid: u32) -> Option<i64> {
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "lstart="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = std::str::from_utf8(&output.stdout).ok()?.trim();
    let converted = epoch_seconds_command(raw)?.output().ok()?;
    if !converted.status.success() {
        return None;
    }
    std::str::from_utf8(&converted.stdout)
        .ok()?
        .trim()
        .parse::<i64>()
        .ok()?
        .checked_mul(1000)
}

/// The `date` invocation that converts an `lstart` timestamp to epoch seconds.
#[cfg(target_os = "macos")]
fn epoch_seconds_command(lstart: &str) -> Option<Command> {
    let mut command = Command::new("date");
    command.args(["-j", "-f", "%a %b %e %T %Y", lstart, "+%s"]);
    Some(command)
}

#[cfg(target_os = "linux")]
fn epoch_seconds_command(lstart: &str) -> Option<Command> {
    let mut command = Command::new("date");
    command.args(["-d", lstart, "+%s"]);
    Some(command)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn epoch_seconds_command(_lstart: &str) -> Option<Command> {
    None
}
