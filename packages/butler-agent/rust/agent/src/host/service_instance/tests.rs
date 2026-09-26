use std::path::PathBuf;

use super::super::ResolvedInstallation;
use super::{
    AdmissionLock, InstanceGuard, instance_is_locked, instance_lock_path, instance_record_path,
    mark_stopping, read_record_at, validate_write_destinations, write_record,
};

struct TemporaryData(PathBuf);

impl TemporaryData {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "butler-native-service-instance-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&path).expect("temporary DATA directory is created");
        Self(path)
    }
}

impl Drop for TemporaryData {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn test_installation(executable: &PathBuf) -> ResolvedInstallation {
    let root = executable
        .parent()
        .expect("test executable has an installation root");
    ResolvedInstallation::desktop(executable, root, root)
        .expect("test executable forms a valid installation")
}

#[test]
fn instance_guard_holds_kernel_lock_and_leaves_lock_inode_persistent() {
    let data = TemporaryData::new();
    let executable = std::env::current_exe()
        .expect("test executable is available")
        .canonicalize()
        .expect("test executable is canonical");
    let installation = test_installation(&executable);
    let guard = InstanceGuard::acquire(&data.0, &executable, &installation)
        .expect("first writer is admitted");

    assert!(instance_is_locked(&data.0).expect("lock state is readable"));
    assert!(
        read_record_at(&instance_record_path(&data.0))
            .expect("record is readable")
            .is_some()
    );
    let duplicate = InstanceGuard::acquire(&data.0, &executable, &installation);
    assert!(matches!(duplicate, Err(message) if message.contains("duplicate_writer")));

    drop(guard);
    assert!(!instance_is_locked(&data.0).expect("lock is released"));
    assert!(
        read_record_at(&instance_record_path(&data.0))
            .expect("record is readable")
            .is_none()
    );
    assert!(instance_lock_path(&data.0).is_file());
}

#[test]
fn guard_cleanup_preserves_record_with_a_different_nonce() {
    let data = TemporaryData::new();
    let executable = std::env::current_exe()
        .expect("test executable is available")
        .canonicalize()
        .expect("test executable is canonical");
    let installation = test_installation(&executable);
    let guard =
        InstanceGuard::acquire(&data.0, &executable, &installation).expect("writer is admitted");
    let path = instance_record_path(&data.0);
    let mut replacement = read_record_at(&path)
        .expect("record is readable")
        .expect("record is present");
    let replacement_nonce = uuid::Uuid::new_v4().to_string();
    replacement.nonce.clone_from(&replacement_nonce);
    write_record(&path, &replacement).expect("replacement record is written");

    drop(guard);
    let persisted = read_record_at(&path)
        .expect("record is readable")
        .expect("different owner nonce is preserved");
    assert_eq!(persisted.nonce, replacement_nonce);
}

#[test]
fn start_admission_is_scoped_to_data_and_released_by_raii() {
    let data = TemporaryData::new();
    let executable = std::env::current_exe()
        .expect("test executable is available")
        .canonicalize()
        .expect("test executable is canonical");
    let installation = test_installation(&executable);
    let admission =
        AdmissionLock::acquire(&data.0, &installation).expect("start admission is acquired");
    let competing = AdmissionLock::acquire(&data.0, &installation);
    assert!(matches!(competing, Err(message) if message == "service_start_admission_busy"));

    drop(admission);
    assert!(AdmissionLock::acquire(&data.0, &installation).is_ok());
}

#[test]
fn late_readiness_cannot_overwrite_a_stop_transition() {
    let data = TemporaryData::new();
    let executable = std::env::current_exe()
        .expect("test executable is available")
        .canonicalize()
        .expect("test executable is canonical");
    let installation = test_installation(&executable);
    let mut guard =
        InstanceGuard::acquire(&data.0, &executable, &installation).expect("writer is admitted");
    let record = read_record_at(&instance_record_path(&data.0))
        .expect("record is readable")
        .expect("record is present");

    mark_stopping(&data.0, &record.nonce, &installation).expect("stop transition is committed");
    assert_eq!(
        guard
            .mark_ready(false, None, false, "ready-at-test".into())
            .expect_err("late readiness cannot replace stopping"),
        "native_service_start_cancelled"
    );
    let persisted = read_record_at(&instance_record_path(&data.0))
        .expect("record is readable")
        .expect("record remains present");
    assert_eq!(persisted.state, "stopping");
}

#[test]
fn state_and_log_symlinks_into_installation_are_rejected_before_writes() {
    let executable = std::env::current_exe()
        .expect("test executable is available")
        .canonicalize()
        .expect("test executable is canonical");
    let installation = test_installation(&executable);

    for destination in ["state", "logs"] {
        let data = TemporaryData::new();
        std::os::unix::fs::symlink(installation.root(), data.0.join(destination))
            .expect("write destination symlink is created");
        assert_eq!(
            validate_write_destinations(&data.0, &installation).unwrap_err(),
            "native_path_configuration_invalid"
        );
    }
}
