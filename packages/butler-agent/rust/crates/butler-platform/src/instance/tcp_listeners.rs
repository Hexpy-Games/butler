//! Listen sockets owned by a process, as reported by the host.
use std::{collections::BTreeSet, io};

#[cfg(target_os = "linux")]
/// Lists TCP ports on which the given process is listening.
pub fn listening_tcp_ports(pid: u32) -> io::Result<BTreeSet<u16>> {
    use std::{fs, path::PathBuf};

    let process = PathBuf::from(format!("/proc/{pid}"));
    let mut inodes = BTreeSet::new();
    for entry in fs::read_dir(process.join("fd"))? {
        let target = match fs::read_link(entry?.path()) {
            Ok(target) => target,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        if let Some(inode) = target
            .to_str()
            .and_then(|target| target.strip_prefix("socket:["))
            .and_then(|target| target.strip_suffix(']'))
        {
            inodes.insert(inode.to_owned());
        }
    }
    let mut ports = BTreeSet::new();
    for table in ["net/tcp", "net/tcp6"] {
        let rows = fs::read_to_string(process.join(table))?;
        for row in rows.lines().skip(1) {
            let columns: Vec<_> = row.split_whitespace().collect();
            if columns.get(3) != Some(&"0A")
                || !columns.get(9).is_some_and(|inode| inodes.contains(*inode))
            {
                continue;
            }
            let port = columns
                .get(1)
                .and_then(|address| address.rsplit_once(':'))
                .and_then(|(_, port)| u16::from_str_radix(port, 16).ok())
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid TCP port"))?;
            ports.insert(port);
        }
    }
    Ok(ports)
}

#[cfg(target_os = "macos")]
/// Lists TCP ports on which the given process is listening.
pub fn listening_tcp_ports(pid: u32) -> io::Result<BTreeSet<u16>> {
    let output = std::process::Command::new("lsof")
        .args(["-nP", "-a", "-p", &pid.to_string(), "-iTCP", "-sTCP:LISTEN"])
        .output()?;
    if output.status.code() == Some(1) && output.stdout.is_empty() && output.stderr.is_empty() {
        return Ok(BTreeSet::new());
    }
    if !output.status.success() {
        return Err(io::Error::other(format!("lsof failed: {}", output.status)));
    }
    let rows = String::from_utf8_lossy(&output.stdout);
    rows.lines()
        .skip(1)
        .map(|row| {
            row.split_whitespace()
                .rev()
                .nth(1)
                .and_then(|address| address.rsplit_once(':'))
                .and_then(|(_, port)| port.parse().ok())
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid TCP port"))
        })
        .collect()
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
/// Lists TCP ports on which the given process is listening.
pub fn listening_tcp_ports(_pid: u32) -> io::Result<BTreeSet<u16>> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "listing TCP listeners is unavailable",
    ))
}
