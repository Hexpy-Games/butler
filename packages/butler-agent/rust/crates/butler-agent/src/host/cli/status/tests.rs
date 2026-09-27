use std::{
    fs,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::PathBuf,
};

use nix::fcntl::{Flock, FlockArg};

use super::instance_lock_is_held;

fn temporary_data_root() -> PathBuf {
    std::env::temp_dir().join(format!(
        "butler-status-test-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ))
}

#[test]
fn status_lock_probe_reads_existing_lock_without_write_access() {
    let data_root = temporary_data_root();
    let state = data_root.join("state");
    fs::create_dir_all(&state).unwrap();
    let lock_path = state.join("butler-agent-native-service.lock");
    let writer = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&lock_path)
        .unwrap();
    let exclusive = Flock::lock(writer, FlockArg::LockExclusive).unwrap();
    fs::set_permissions(&lock_path, fs::Permissions::from_mode(0o400)).unwrap();

    assert!(instance_lock_is_held(&data_root).unwrap());

    drop(exclusive);
    fs::remove_dir_all(data_root).unwrap();
}
