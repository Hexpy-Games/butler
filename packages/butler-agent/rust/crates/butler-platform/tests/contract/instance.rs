//! The instance lock.

use std::fs::{File, OpenOptions};
use std::path::Path;

use butler_platform::instance::{InstanceLock, LockError};

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

/// Like `nix`'s `Flock`, dropping the lock unlocks it even while a duplicate
/// of its file is still open.
#[test]
fn dropping_the_lock_releases_it_despite_a_duplicated_file() {
    let path = scratch("lock-duplicate").join("instance.lock");
    let held = InstanceLock::try_exclusive(open_lock_file(&path)).unwrap();
    let duplicate = held.file().try_clone().unwrap();
    drop(held);
    InstanceLock::try_exclusive(open_lock_file(&path)).unwrap();
    drop(duplicate);
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
