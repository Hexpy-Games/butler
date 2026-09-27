use std::path::PathBuf;

use super::{super::ResolvedInstallation, log_file};

struct TemporaryRoot(PathBuf);

impl TemporaryRoot {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "butler-service-log-installation-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&path).expect("temporary test root is created");
        Self(path)
    }
}

impl Drop for TemporaryRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn service_log_file_rejects_a_symlink_into_installation() {
    let root = TemporaryRoot::new();
    let installation_root = root.0.join("installation");
    let data_root = root.0.join("data");
    let resources = installation_root.join("resources");
    std::fs::create_dir_all(&resources).expect("installation resources are created");
    let executable = installation_root.join("butler-agent");
    std::fs::write(&executable, b"test executable").expect("installation file is created");
    let installed_log = installation_root.join("existing.log");
    std::fs::write(&installed_log, b"preserve").expect("installed file is created");
    let logs = data_root.join("logs");
    std::fs::create_dir_all(&logs).expect("DATA logs directory is created");
    let target = logs.join("butler-agent-service.stdout.log");
    std::os::unix::fs::symlink(&installed_log, &target).expect("log symlink is created");
    let installation = ResolvedInstallation::desktop(&executable, &installation_root, &resources)
        .expect("installation paths are valid");

    assert_eq!(
        log_file(&target, &installation).unwrap_err(),
        "native_service_logs_unavailable"
    );
    assert_eq!(std::fs::read(&installed_log).unwrap(), b"preserve");
}
