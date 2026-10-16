//! One shutdown snapshot, then kernel exit notifications; no liveness polling.
use std::{io, os::fd::OwnedFd};

use nix::{
    errno::Errno,
    unistd::{Pid, getpgid},
};
use rustix::process::{PidfdFlags, pidfd_open};
use tokio::io::unix::AsyncFd;

pub(super) async fn wait_for_group(group: u32) -> io::Result<()> {
    // The group has already received SIGKILL. Keep all remaining members pinned
    // before awaiting any of them, including orphans whose launcher exited first.
    let members = tokio::task::spawn_blocking(move || members(group))
        .await
        .map_err(io::Error::other)??;
    for member in members {
        let fd = AsyncFd::new(member)?;
        drop(fd.readable().await?);
    }
    Ok(())
}

fn members(group: u32) -> io::Result<Vec<OwnedFd>> {
    let group = i32::try_from(group).map_err(io::Error::other)?;
    let mut members = Vec::new();
    // Linux has no process-group pidfd. Enumerate IDs once at termination and
    // query group membership by syscall; never load process cmdlines or stats.
    for entry in std::fs::read_dir("/proc")? {
        let entry = entry?;
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<i32>().ok())
        else {
            continue;
        };
        if !in_group(pid, group)? {
            continue;
        }
        let Some(id) = rustix::process::Pid::from_raw(pid) else {
            continue;
        };
        let fd = match pidfd_open(id, PidfdFlags::empty()) {
            Ok(fd) => fd,
            Err(rustix::io::Errno::SRCH) => continue,
            Err(error) => return Err(error.into()),
        };
        // Pin first, then recheck, so an exited/reused PID cannot add a foreign
        // process to the wait. Pidfds are readable for zombies as well as exits.
        if in_group(pid, group)? {
            members.push(fd);
        }
    }
    Ok(members)
}

fn in_group(pid: i32, group: i32) -> io::Result<bool> {
    match getpgid(Some(Pid::from_raw(pid))) {
        Ok(actual) => Ok(actual.as_raw() == group),
        Err(Errno::ESRCH) => Ok(false),
        Err(error) => Err(error.into()),
    }
}
