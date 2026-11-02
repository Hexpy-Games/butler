//! Per-helper subst ownership; PID creation time fences crash recovery.
use super::Error;
use crate::command_sandbox::mxc_policy::drive_pick;
use serde::{Deserialize, Serialize};
use std::os::windows::fs::OpenOptionsExt;
use std::{
    fs, io,
    io::Write,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
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
        let _phase = super::timing::Phase::start("drive_claim");
        let target = crate::secure_fs::canonicalize(target)?;
        let text = target.to_str().ok_or("invalid_project_path")?;
        if text.encode_utf16().count() > MAX_SUBST_TARGET_UNITS {
            return Err("subst_target_too_long".into());
        }
        let root = text.get(..3).ok_or("non_fixed_drive")?;
        if winsafe::GetDriveType(Some(root)) != co::DRIVE::FIXED {
            return Err("non_fixed_drive".into());
        }
        let directory = data.join(crate::data_paths::SANDBOX_DRIVES);
        fs::create_dir_all(&directory)?;
        let started = start_time(std::process::id())?.ok_or("helper_identity_missing")?;
        let letters = drive_pick::candidates(winsafe::GetLogicalDrives(), &persistent()?, &[]);
        for letter in letters {
            let journal = directory.join(format!("{letter}.json"));
            let mut file = match fs::OpenOptions::new()
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
            file.write_all(&serde_json::to_vec(&entry)?)?;
            // Process crashes retain the OS cache; reboot removes DOS devices.
            // No disk durability is needed for this transient ownership journal.
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
    pub(super) fn temporary(
        data: &Path,
        scratch: &Path,
        policy: &Path,
    ) -> Result<(Option<Self>, String), Error> {
        let path = crate::secure_fs::canonicalize(scratch)?.join("t");
        let text = path.to_str().ok_or("invalid_scratch_path")?;
        // The in-container bootstrap restores this exact path after MXC's
        // profile rewrite. A short physical path needs no extra subst process.
        if text.encode_utf16().count() + 1 + 38 < 260 {
            return Ok((None, text.to_owned()));
        }
        let (drive, temporary) = Self::claim_scratch(data, scratch, policy)?;
        Ok((Some(drive), temporary))
    }
    pub(super) fn claim_scratch(
        data: &Path,
        scratch: &Path,
        policy: &Path,
    ) -> Result<(Self, String), Error> {
        let scratch = crate::secure_fs::canonicalize_extended(scratch)?;
        // subst itself has a legacy target-length limit. Alias the nearest
        // usable ancestor; grants remain on the exact physical command scratch.
        // Keep the mapping target alive when invocation cleanup removes scratch
        // before crash reconciliation has removed this helper's drive.
        let target = scratch
            .parent()
            .ok_or("scratch_parent_missing")?
            .ancestors()
            .find(|path| {
                path.as_os_str().to_string_lossy().encode_utf16().count() <= MAX_SUBST_TARGET_UNITS
            })
            .ok_or("subst_target_too_long")?;
        let tail = scratch.strip_prefix(target)?.join("t");
        let tail = tail.to_str().ok_or("invalid_scratch_path")?;
        // Include the drive prefix, separator, longest policy-test name and NUL.
        if 3 + tail.encode_utf16().count() + 1 + 38 >= 260 {
            return Err("scratch_temp_path_too_long".into());
        }
        let drive = Self::claim(data, target, policy)?;
        let temporary = format!("{}:\\{tail}", drive.letter);
        Ok((drive, temporary))
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
        self.start_cleanup()?.finish()
    }
    pub(super) fn start_cleanup(&self) -> io::Result<Cleanup<'_>> {
        let phase = super::timing::Phase::start("drive_cleanup");
        let child = if self.matches()? {
            Some(spawn_subst(&[format!("{}:", self.letter), "/D".into()])?)
        } else {
            None
        };
        Ok(Cleanup {
            drive: self,
            child,
            _phase: phase,
        })
    }
}

/// Scratch deletion can run while subst exits, without another worker thread.
pub(super) struct Cleanup<'a> {
    drive: &'a Drive,
    child: Option<Child>,
    _phase: super::timing::Phase,
}
impl Cleanup<'_> {
    pub(super) fn finish(mut self) -> io::Result<()> {
        let status = self.child.as_mut().map(Child::wait).transpose()?;
        self.child = None;
        if status.is_some_and(|status| !status.success()) && self.drive.matches()? {
            return Err(io::Error::other("subst_remove_failed"));
        }
        match fs::remove_file(&self.drive.journal) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            result => result,
        }
    }
}
impl Drop for Cleanup<'_> {
    fn drop(&mut self) {
        if let Some(child) = &mut self.child {
            // Never let a cleanup child outlive its helper on an early return.
            let _ = child.wait();
        }
    }
}
fn subst(args: &[String]) -> io::Result<std::process::ExitStatus> {
    spawn_subst(args)?.wait()
}
fn spawn_subst(args: &[String]) -> io::Result<Child> {
    Command::new(system_subst()?)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
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
    let directory = data.join(crate::data_paths::SANDBOX_DRIVES);
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return super::recovery::reconcile_policies(data);
        }
        Err(e) => return Err(e),
    };
    for item in entries {
        if let Err(error) = reconcile_entry(item) {
            eprintln!("sandbox drive reconciliation failed: {error}");
        }
    }
    super::recovery::reconcile_policies(data)
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

#[cfg(feature = "test-support")]
pub(in crate::command_sandbox) fn verify_long_mapping() -> Result<(), Error> {
    let base = std::env::temp_dir().join(format!(
        "butler-drive-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos()
    ));
    let mut target = base.clone();
    while target.as_os_str().to_string_lossy().encode_utf16().count() <= 320 {
        target = target.join("a".repeat(50));
    }
    fs::create_dir_all(target.join("t"))?;
    let result = (|| {
        let (drive, temporary) = Drive::claim_scratch(&base, &target, &base.join("policy.json"))?;
        eprintln!(
            "Windows scratch physical_utf16={} temporary_utf16={}",
            target.as_os_str().to_string_lossy().encode_utf16().count(),
            temporary.encode_utf16().count()
        );
        let shell = PathBuf::from(std::env::var("SYSTEMROOT")?)
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let output = Command::new(shell)
            .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
                "$ErrorActionPreference='Stop'; $ExecutionContext.SessionState.LanguageMode; $p=[IO.Path]::Combine([IO.Path]::GetTempPath(),'__PSScriptPolicyTest_roundtrip.ps1'); [IO.File]::WriteAllText($p,'complete'); [IO.File]::ReadAllText($p); [IO.File]::Delete($p)"])
            .env("TEMP", &temporary)
            .env("TMP", &temporary)
            .output();
        // Parent-side recovery can remove command scratch before drive recovery.
        fs::remove_dir_all(&target)?;
        let cleaned = drive.cleanup();
        let output = output?;
        cleaned?;
        assert_eq!(
            winsafe::GetLogicalDrives() & (1 << (drive.letter as u8 - b'A')),
            0
        );
        assert!(output.status.success(), "{output:?}");
        let text = String::from_utf8_lossy(&output.stdout);
        assert!(
            text.lines().any(|line| line == "FullLanguage"),
            "{output:?}"
        );
        assert!(text.lines().any(|line| line == "complete"), "{output:?}");
        assert_eq!(fs::read_dir(base.join("sandbox/drives"))?.count(), 0);
        Ok(())
    })();
    let cleanup = fs::remove_dir_all(base);
    cleanup?;
    result
}
