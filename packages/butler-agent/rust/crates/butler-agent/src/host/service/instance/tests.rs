use std::path::PathBuf;

use super::validate_write_destinations;
use crate::host::ResolvedInstallation;

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

pub(crate) fn state_and_log_symlinks_into_installation_are_rejected_before_writes() {
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
