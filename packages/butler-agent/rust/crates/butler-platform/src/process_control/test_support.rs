//! Isolated child profiles and native protocol peers for lifecycle tests.
use std::path::{Path, PathBuf};

/// The caller creates these directories before launching the child.
pub fn fixture_profile_environment(home: &Path) -> Vec<(&'static str, PathBuf)> {
    #[cfg(windows)]
    return vec![
        ("USERPROFILE", home.to_owned()),
        ("APPDATA", home.join("AppData/Roaming")),
        ("LOCALAPPDATA", home.join("AppData/Local")),
    ];
    #[cfg(not(windows))]
    {
        let _ = home;
        Vec::new()
    }
}

/// Reads one line, replies after 200 ms, then stays alive until its owner stops it.
/// The caller owns stdio and must kill and reap the child on every exit path.
pub fn slow_line_peer(response: &str) -> tokio::process::Command {
    #[cfg(unix)]
    {
        let mut command = tokio::process::Command::new("/bin/sh");
        command.args([
            "-c",
            "IFS= read -r line; sleep 0.2; printf '%s\\n' \"$1\"; exec sleep 30",
            "protocol-peer",
            response,
        ]);
        command
    }
    #[cfg(windows)]
    {
        let response = response.replace('\'', "''");
        let script = format!(
            "[Console]::ReadLine() | Out-Null; [Threading.Thread]::Sleep(200); [Console]::WriteLine('{response}'); [Threading.Thread]::Sleep(30000)"
        );
        let mut command = tokio::process::Command::new("powershell.exe");
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &script,
        ]);
        command
    }
}
