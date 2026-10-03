//! Read-only role counts for isolated process and idle acceptance probes.
use super::Role;
use std::io;

/// Count direct children bearing one of the platform's managed role names.
///
/// # Errors
/// Returns process-query errors, including an unavailable parent process.
pub fn child_count(parent: u32, role: Role) -> io::Result<usize> {
    #[cfg(windows)]
    {
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
        let parent = Pid::from_u32(parent);
        let mut system = System::new();
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing(),
        );
        if system.process(parent).is_none() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "parent process unavailable",
            ));
        }
        Ok(system
            .processes()
            .values()
            .filter(|process| {
                let name = process.name().to_string_lossy();
                process.parent() == Some(parent)
                    && [role.name(), role.short_name(), role.file_name()].contains(&name.as_ref())
            })
            .count())
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let mut count = 0;
        for pid in children(parent)? {
            match super::observed_name(pid, role) {
                Ok(Some((observed, expected))) if observed == expected => count += 1,
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        Ok(count)
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        let _ = (parent, role);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "process queries unavailable",
        ))
    }
}

#[cfg(target_os = "linux")]
fn children(parent: u32) -> io::Result<std::collections::HashSet<u32>> {
    let mut children = std::collections::HashSet::new();
    for task in std::fs::read_dir(format!("/proc/{parent}/task"))? {
        let task = task?;
        let text = match std::fs::read_to_string(task.path().join("children")) {
            Ok(text) => text,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        for pid in text.split_whitespace() {
            children.insert(pid.parse::<u32>().map_err(io::Error::other)?);
        }
    }
    Ok(children)
}
#[cfg(target_os = "macos")]
fn children(parent: u32) -> io::Result<Vec<u32>> {
    libproc::processes::pids_by_type(libproc::processes::ProcFilter::ByParentProcess {
        ppid: parent,
    })
}
