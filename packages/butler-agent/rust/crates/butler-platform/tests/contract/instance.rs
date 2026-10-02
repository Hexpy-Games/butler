//! The instance lock, process identity and stopping an identified process.

use std::fs::{self, File, OpenOptions};
use std::path::Path;

use butler_platform::instance::{
    InstanceLock, LockError, StopError, process_executable, process_start, same_executable,
    terminate,
};
use butler_platform::process_control::{ExitSignal, SIGNALS, terminating_signal};

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
    // The waiting variant takes a free lock at once and excludes like the others.
    let held = InstanceLock::exclusive(open_lock_file(&path)).unwrap();
    assert!(matches!(
        InstanceLock::try_shared(open_lock_file(&path)),
        Err(LockError::Busy)
    ));
    drop(held);
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

/// A controller ends the lock holder only by its identity: its start (stable
/// while it runs) and its executable, compared as a file (see
/// [`assert_executable_identity_is_the_file`]). `terminate` refuses another
/// start, as it would a reused id, and the holder's death releases the lock.
// test-category: security
#[test]
fn instance_lock_is_released_when_its_identified_holder_is_terminated() {
    assert_executable_identity_is_the_file();
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
    let pid = holder.id();
    match process_start(pid) {
        Ok(Some(started)) => {
            assert_eq!(process_start(pid).unwrap(), Some(started.clone()));
            let executable = std::env::current_exe().unwrap().canonicalize().unwrap();
            let observed = process_executable(pid).unwrap().unwrap();
            assert!(same_executable(&executable.to_string_lossy(), &observed));
            assert!(matches!(
                terminate(pid, "another start"),
                Err(StopError::Gone)
            ));
            terminate(pid, &started).unwrap();
            #[cfg(target_os = "macos")]
            let zombie = unreaped_identity(pid, &started);
            let status = holder.wait().unwrap();
            #[cfg(target_os = "macos")]
            {
                assert_eq!(zombie.start.unwrap(), None, "an unreaped exit is not live");
                assert_eq!(
                    zombie.executable.unwrap(),
                    None,
                    "a zombie has no executable"
                );
                assert!(matches!(zombie.termination, Err(StopError::Gone)));
            }
            assert_eq!(
                terminating_signal(status),
                SIGNALS.then_some(ExitSignal::Kill)
            );
            assert_ne!(process_start(pid).unwrap(), Some(started));
        }
        other => panic!("the holder's identity: {other:?}"),
    }
    InstanceLock::try_exclusive(open_lock_file(&path)).unwrap();
}

#[cfg(target_os = "macos")]
struct UnreapedIdentity {
    start: Result<Option<String>, butler_platform::instance::IdentityError>,
    executable: Result<Option<String>, butler_platform::instance::IdentityError>,
    termination: Result<(), StopError>,
}

#[cfg(target_os = "macos")]
fn unreaped_identity(pid: u32, started: &str) -> UnreapedIdentity {
    // Leave our child unreaped until the kernel reports its zombie state.
    super::eventually("unreaped holder exit", || {
        std::process::Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "stat="])
            .output()
            .is_ok_and(|output| {
                String::from_utf8_lossy(&output.stdout)
                    .trim()
                    .starts_with('Z')
            })
    });
    UnreapedIdentity {
        start: process_start(pid),
        executable: process_executable(pid),
        termination: terminate(pid, started),
    }
}

/// macOS names a hard-linked executable by its most recent lookup, so the
/// identity check compares files, not spellings: another link of the same
/// file matches, a copy or a missing file does not.
fn assert_executable_identity_is_the_file() {
    let directory = scratch("executable-identity");
    let original = directory.join("butler-agent");
    let link = directory.join("butler-agent-link");
    let copy = directory.join("butler-agent-copy");
    fs::write(&original, b"agent").unwrap();
    fs::hard_link(&original, &link).unwrap();
    fs::copy(&original, &copy).unwrap();
    let [original, link, copy] =
        [&original, &link, &copy].map(|path| path.to_string_lossy().into_owned());

    assert!(same_executable(&original, &original));
    assert!(!same_executable(&original, &copy));
    assert!(!same_executable(&original, &format!("{original}-missing")));
    // Without file ids (Windows, for now) only the same path matches.
    let linked = !cfg!(windows);
    assert_eq!(same_executable(&original, &link), linked);
    assert_eq!(same_executable(&link, &original), linked);
    let _ = fs::remove_dir_all(&directory);
}
