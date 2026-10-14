//! Per-helper subst ownership; PID creation time fences crash recovery.
use super::Error;
use crate::command_sandbox::mxc_policy::drive_pick;
use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use winsafe::co;

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
        if text.len() > 240 {
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
            let drive = Self {
                letter,
                journal,
                entry,
            };
            if subst(&[format!("{letter}:"), text.into()])?.success() && drive.matches()? {
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
        if self.matches()? && !subst(&[format!("{}:", self.letter), "/D".into()])?.success() {
            return Err(io::Error::other("subst_remove_failed"));
        }
        fs::remove_file(&self.journal)
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
fn start_time(pid: u32) -> io::Result<Option<u64>> {
    let process =
        match winsafe::HPROCESS::OpenProcess(co::PROCESS::QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(process) => process,
            Err(e) if e == co::ERROR::INVALID_PARAMETER => return Ok(None),
            Err(e) => return Err(io::Error::other(e)),
        };
    let (created, exited, _, _) = process.GetProcessTimes().map_err(io::Error::other)?;
    Ok((u64::from(exited) == 0).then(|| u64::from(created)))
}
pub(in crate::command_sandbox) fn reconcile(data: &Path) -> io::Result<()> {
    let directory = data.join("sandbox/drives");
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    for item in entries {
        let item = item?;
        let name = item.file_name();
        let name = name.to_string_lossy();
        let bytes = name.as_bytes();
        let Some(letter) = bytes.first().copied() else {
            continue;
        };
        if bytes.len() != 6 || !name.ends_with(".json") || !letter.is_ascii_uppercase() {
            continue;
        }
        let entry: Entry =
            serde_json::from_slice(&fs::read(item.path())?).map_err(io::Error::other)?;
        if start_time(entry.pid)? == Some(entry.started) {
            continue;
        }
        let drive = Drive {
            letter: char::from(letter),
            journal: item.path(),
            entry,
        };
        drive.cleanup()?;
        let policies = dunce::canonicalize(data.join("sandbox/policies"))?;
        if let Ok(policy) = dunce::canonicalize(&drive.entry.policy)
            && policy.parent() == Some(policies.as_path())
        {
            fs::remove_file(policy)?;
        }
    }
    Ok(())
}
