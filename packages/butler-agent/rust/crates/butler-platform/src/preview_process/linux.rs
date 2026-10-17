//! One shutdown snapshot, then kernel exit notifications; no liveness polling.
use std::{io, os::fd::OwnedFd};

use rustix::{
    io::Errno,
    process::{Pid, PidfdFlags, getpgid, getpid, pidfd_open},
};
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
    // Older kernels and seccomp may deny pidfds. Keep the pre-pidfd contract:
    // SIGKILL the tree and reap the launcher, without promising a group wait.
    match open_pidfd(getpid()) {
        Ok(_) => {}
        Err(Errno::NOSYS | Errno::PERM) => return Ok(members),
        Err(error) => return Err(error.into()),
    }
    // Linux has no process-group pidfd. Snapshot membership once at termination;
    // all procfs reads run on the blocking worker, never in a liveness poll.
    for entry in std::fs::read_dir("/proc")? {
        let entry = entry?;
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<i32>().ok())
        else {
            continue;
        };
        if !snapshot_member(pid, group)? {
            continue;
        }
        let Some(id) = Pid::from_raw(pid) else {
            continue;
        };
        let fd = match open_pidfd(id) {
            Ok(fd) => fd,
            Err(Errno::SRCH) => continue,
            Err(Errno::NOSYS | Errno::PERM) => return Ok(Vec::new()),
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

fn snapshot_member(pid: i32, group: i32) -> io::Result<bool> {
    // Kernel tasks can have pgrp=0, which rustix's nonzero Pid cannot represent.
    // Filter using procfs first; getpgid below rechecks membership after pinning.
    let stat = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    // comm is parenthesized and can itself contain spaces and parentheses.
    let pgrp = stat
        .rsplit_once(')')
        .and_then(|(_, fields)| fields.split_whitespace().nth(2))
        .and_then(|value| value.parse::<i32>().ok())
        .ok_or_else(|| io::Error::other("Invalid process group in procfs stat"))?;
    Ok(pgrp == group)
}

fn in_group(pid: i32, group: i32) -> io::Result<bool> {
    let Some(pid) = Pid::from_raw(pid) else {
        return Ok(false);
    };
    match getpgid(Some(pid)) {
        Ok(actual) => Ok(actual.as_raw_pid() == group),
        Err(Errno::SRCH) => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn open_pidfd(pid: Pid) -> Result<OwnedFd, Errno> {
    #[cfg(feature = "test-support")]
    match std::env::var("BUTLER_TEST_PREVIEW_PIDFD").as_deref() {
        Ok("ENOSYS") => return Err(Errno::NOSYS),
        Ok("EPERM") => return Err(Errno::PERM),
        _ => {}
    }
    pidfd_open(pid, PidfdFlags::empty())
}
