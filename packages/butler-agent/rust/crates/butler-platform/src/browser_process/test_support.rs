//! Read-only process evidence for isolated browser E2E scenarios.

use std::io;

/// Lists commands containing both the executable name and the scenario marker.
/// Only E2E callers use this process-table scan, never a runtime request path.
///
/// # Errors
/// Returns an error if the host process listing cannot be read.
pub fn matching_processes(executable: &str, marker: &str) -> io::Result<Vec<String>> {
    #[cfg(unix)]
    {
        let output = std::process::Command::new("ps")
            .args(["-axo", "pid=,command="])
            .output()?;
        if !output.status.success() {
            return Err(io::Error::other("process listing failed"));
        }
        Ok(String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter(|line| line.contains(executable) && line.contains(marker))
            .map(str::to_owned)
            .collect())
    }
    #[cfg(windows)]
    {
        use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

        let mut system = System::new();
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
        );
        let mut commands: Vec<String> = system
            .processes()
            .iter()
            .filter_map(|(pid, process)| {
                let command = process
                    .cmd()
                    .iter()
                    .map(|arg| arg.to_string_lossy())
                    .collect::<Vec<_>>()
                    .join(" ");
                (command.contains(executable) && command.contains(marker))
                    .then(|| format!("{} {command}", pid.as_u32()))
            })
            .collect();
        commands.sort();
        Ok(commands)
    }
}
