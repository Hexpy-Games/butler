//! The instance lock and process identity.

use std::fs::{File, OpenOptions};
use std::path::Path;

use butler_platform::instance::{
    IdentityError, InstanceLock, LockError, process_executable, process_start_identity,
};

use super::{LOCK, REPORT, helper_command, read_report, scratch};

pub(super) fn open_lock_file(path: &Path) -> File {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .unwrap()
}

#[test]
fn instance_lock_is_exclusive_per_open_file_until_dropped() {
    let path = scratch("lock").join("instance.lock");
    let held = InstanceLock::try_exclusive(open_lock_file(&path)).unwrap();
    assert!(matches!(
        InstanceLock::try_exclusive(open_lock_file(&path)),
        Err(LockError::Busy)
    ));
    assert!(matches!(
        InstanceLock::try_shared(open_lock_file(&path)),
        Err(LockError::Busy)
    ));
    drop(held);
    let first = InstanceLock::try_shared(open_lock_file(&path)).unwrap();
    let second = InstanceLock::try_shared(open_lock_file(&path)).unwrap();
    assert!(matches!(
        InstanceLock::try_exclusive(open_lock_file(&path)),
        Err(LockError::Busy)
    ));
    drop((first, second));
    InstanceLock::try_exclusive(open_lock_file(&path)).unwrap();
}

#[test]
fn instance_lock_is_released_when_its_holder_dies() {
    let directory = scratch("lock-holder");
    let path = directory.join("instance.lock");
    let report = directory.join("report");
    let mut holder = helper_command("lock")
        .env(LOCK, &path)
        .env(REPORT, &report)
        .spawn()
        .unwrap();
    assert_eq!(read_report(&report), "locked");
    assert!(matches!(
        InstanceLock::try_exclusive(open_lock_file(&path)),
        Err(LockError::Busy)
    ));
    holder.kill().unwrap();
    holder.wait().unwrap();
    InstanceLock::try_exclusive(open_lock_file(&path)).unwrap();
}

#[test]
fn process_identity_is_stable_and_names_the_running_executable() {
    let pid = std::process::id();
    if cfg!(windows) {
        assert!(matches!(
            process_start_identity(pid),
            Err(IdentityError::Unsupported)
        ));
        assert!(matches!(
            process_executable(pid),
            Err(IdentityError::Unsupported)
        ));
        return;
    }
    let start = process_start_identity(pid).unwrap().unwrap();
    let prefix = if cfg!(target_os = "macos") {
        "macos:"
    } else {
        "linux:"
    };
    assert!(start.starts_with(prefix), "{start}");
    assert_eq!(process_start_identity(pid).unwrap(), Some(start));
    let executable = std::env::current_exe().unwrap().canonicalize().unwrap();
    assert_eq!(
        process_executable(pid).unwrap(),
        Some(executable.to_string_lossy().into_owned())
    );
}

#[test]
fn a_reaped_process_has_no_identity() {
    let mut child = helper_command("exit").spawn().unwrap();
    let pid = child.id();
    child.wait().unwrap();
    if cfg!(windows) {
        return;
    }
    assert_eq!(process_start_identity(pid).unwrap(), None);
    assert_eq!(process_executable(pid).unwrap(), None);
}
