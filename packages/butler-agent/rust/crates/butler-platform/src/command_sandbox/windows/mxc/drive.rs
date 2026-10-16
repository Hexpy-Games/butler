//! Per-helper subst ownership; PID creation time fences crash recovery.
use super::Error;
use crate::command_sandbox::mxc_policy::drive_pick;
use serde::{Deserialize, Serialize};
use std::os::windows::fs::OpenOptionsExt;
use std::{
    fs, io,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use winsafe::co;
const MAX_SUBST_TARGET_UNITS: usize = 240;

#[derive(Serialize, Deserialize)]
struct Entry {
    target: PathBuf,
    pid: u32,
    started: u64,
    policy: PathBuf,
}
pub(super) struct Drive {
    pub letter: char,
    journal: PathBuf,
    entry: Entry,
}
impl Drive {
    pub(super) fn claim(data: &Path, target: &Path, policy: &Path) -> Result<Self, Error> {
        let target = dunce::canonicalize(target)?;
        let text = target.to_str().ok_or("invalid_project_path")?;
        if text.encode_utf16().count() > MAX_SUBST_TARGET_UNITS {
            return Err("subst_target_too_long".into());
        }
        let root = text.get(..3).ok_or("non_fixed_drive")?;
        if winsafe::GetDriveType(Some(root)) != co::DRIVE::FIXED {
            return Err("non_fixed_drive".into());
        }
        let directory = data.join("sandbox/drives");
        fs::create_dir_all(&directory)?;
        let started = start_time(std::process::id())?.ok_or("helper_identity_missing")?;
        let letters = drive_pick::candidates(winsafe::GetLogicalDrives(), &persistent()?, &[]);
        for letter in letters {
            let journal = directory.join(format!("{letter}.json"));
            let file = match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .share_mode(0)
                .open(&journal)
            {
                Ok(file) => file,
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e.into()),
            };
            let entry = Entry {
                target: target.clone(),
                pid: std::process::id(),
                started,
                policy: policy.into(),
            };
            serde_json::to_writer(&file, &entry)?;
            file.sync_all()?;
            drop(file);
            let drive = Self {
                letter,
                journal,
                entry,
            };
            let status = subst(&[format!("{letter}:"), text.into()]);
            match status {
                Ok(status) if status.success() => {}
                Ok(_) => {
                    fs::remove_file(&drive.journal)?;
                    continue;
                }
                Err(error) => {
                    fs::remove_file(&drive.journal)?;
                    return Err(error.into());
                }
            }
            if drive.matches()? {
                return Ok(drive);
            }
            drive.cleanup()?;
        }
        Err("no_free_drive".into())
    }
    fn matches(&self) -> io::Result<bool> {
        let root = format!("{}:\\", self.letter);
        match same_file::is_same_file(root, &self.entry.target) {
            Ok(equal) => Ok(equal),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e),
        }
    }
    pub(super) fn cleanup(&self) -> io::Result<()> {
        if self.matches()?
            && !subst(&[format!("{}:", self.letter), "/D".into()])?.success()
            && self.matches()?
        {
            return Err(io::Error::other("subst_remove_failed"));
        }
        match fs::remove_file(&self.journal) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            result => result,
        }
    }
}
fn subst(args: &[String]) -> io::Result<std::process::ExitStatus> {
    Command::new(system_subst()?)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
}
fn system_subst() -> io::Result<PathBuf> {
    let root =
        std::env::var_os("SYSTEMROOT").ok_or_else(|| io::Error::other("SYSTEMROOT required"))?;
    Ok(PathBuf::from(root).join("System32/subst.exe"))
}
fn persistent() -> io::Result<Vec<char>> {
    let key = match winsafe::HKEY::CURRENT_USER.RegOpenKeyEx(
        Some("Network"),
        co::REG_OPTION::NON_VOLATILE,
        co::KEY::READ,
    ) {
        Ok(key) => key,
        Err(e) if e == co::ERROR::FILE_NOT_FOUND => return Ok(Vec::new()),
        Err(e) => return Err(io::Error::other(e)),
    };
    key.RegEnumKeyEx()
        .map_err(io::Error::other)?
        .map(|name| {
            name.map_err(io::Error::other).and_then(|s| {
                s.chars()
                    .next()
                    .ok_or_else(|| io::Error::other("invalid network drive"))
            })
        })
        .collect()
}
pub(super) fn start_time(pid: u32) -> io::Result<Option<u64>> {
    let process =
        match winsafe::HPROCESS::OpenProcess(co::PROCESS::QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(process) => process,
            Err(error) => return inaccessible_process(error),
        };
    let (created, exited, _, _) = process.GetProcessTimes().map_err(io::Error::other)?;
    Ok((u64::from(exited) == 0).then(|| u64::from(created)))
}
pub(super) fn inaccessible_process(error: co::ERROR) -> io::Result<Option<u64>> {
    if error == co::ERROR::INVALID_PARAMETER || error == co::ERROR::ACCESS_DENIED {
        Ok(None)
    } else {
        Err(io::Error::other(error))
    }
}
pub(in crate::command_sandbox) fn reconcile(data: &Path) -> io::Result<()> {
    let directory = data.join("sandbox/drives");
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return super::prepare::reconcile_policies(data);
        }
        Err(e) => return Err(e),
    };
    for item in entries {
        if let Err(error) = reconcile_entry(item) {
            eprintln!("sandbox drive reconciliation failed: {error}");
        }
    }
    super::prepare::reconcile_policies(data)
}

fn reconcile_entry(item: io::Result<fs::DirEntry>) -> io::Result<()> {
    let item = item?;
    let name = item.file_name();
    let name = name.to_string_lossy();
    let bytes = name.as_bytes();
    let Some(letter) = bytes.first().copied() else {
        return Ok(());
    };
    if bytes.len() != 6 || !name.ends_with(".json") || !(b'D'..=b'Z').contains(&letter) {
        return Ok(());
    }
    let bytes = match fs::read(item.path()) {
        Ok(bytes) => bytes,
        Err(error)
            if error.raw_os_error() == Some(32) || error.kind() == io::ErrorKind::NotFound =>
        {
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    let entry: Entry = match serde_json::from_slice(&bytes) {
        Ok(entry) => entry,
        Err(_) => {
            // An exclusive writer cannot be read mid-claim. A torn claim
            // never reached subst; forget it without touching any mapping.
            fs::remove_file(item.path())?;
            return Ok(());
        }
    };
    if start_time(entry.pid)? == Some(entry.started) {
        return Ok(());
    }
    let drive = Drive {
        letter: char::from(letter),
        journal: item.path(),
        entry,
    };
    drive.cleanup()?;
    Ok(())
}

pub(super) fn identity() -> io::Result<(u32, u64)> {
    let pid = std::process::id();
    let started = start_time(pid)?.ok_or_else(|| io::Error::other("helper_identity_missing"))?;
    Ok((pid, started))
}

#[cfg(feature = "test-support")]
pub(in crate::command_sandbox) fn verify_inaccessible_process() {
    assert!(matches!(
        inaccessible_process(co::ERROR::ACCESS_DENIED),
        Ok(None)
    ));
    assert!(matches!(
        inaccessible_process(co::ERROR::INVALID_PARAMETER),
        Ok(None)
    ));
    assert!(inaccessible_process(co::ERROR::INVALID_HANDLE).is_err());
}
