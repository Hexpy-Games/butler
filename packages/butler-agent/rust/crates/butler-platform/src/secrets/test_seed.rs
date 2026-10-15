//! Seed a suffixed test service for the exact binaries exercising a migration.
use super::SecretKey;
use std::path::Path;

/// Test fixtures created by one unsigned binary must also be readable by the
/// unsigned Agent binary. This does not change any product credential's ACL.
pub fn seed_system_secret_for_test_apps(
    home: &Path,
    key: &SecretKey,
    fixture: &str,
    applications: &[&Path],
) -> std::io::Result<()> {
    if !super::test_keychain::test_service(key)
        || applications.is_empty()
        || applications.iter().any(|path| !path.is_absolute())
    {
        return Err(std::io::Error::other(
            "a suffixed test service and exact applications are required",
        ));
    }
    seed(home, key, fixture, applications)
}

#[cfg(target_os = "macos")]
fn seed(
    home: &Path,
    key: &SecretKey,
    fixture: &str,
    applications: &[&Path],
) -> std::io::Result<()> {
    let path = super::test_keychain::path(home)?;
    let mut command = std::process::Command::new("/usr/bin/security");
    command.env("HOME", home).args([
        "add-generic-password",
        "-U",
        "-s",
        key.service(),
        "-a",
        key.account(),
        "-w",
        fixture,
    ]);
    for application in applications {
        command.arg("-T").arg(application);
    }
    let output = command.arg(&path).output()?;
    if !output.status.success() {
        return Err(std::io::Error::other("test keychain seed failed"));
    }
    // -T sets the trusted application list, but Apple's CLI also adds an
    // apple-tool partition. Ad-hoc binaries need their exact CDHashes too.
    let partitions = applications
        .iter()
        .map(|app| {
            let output = std::process::Command::new("/usr/bin/codesign")
                .arg("-dvvv")
                .arg(app)
                .output()?;
            let metadata = String::from_utf8_lossy(&output.stderr);
            let hash = metadata
                .lines()
                .find_map(|line| line.strip_prefix("CDHash="))
                .filter(|hash| hash.len() == 40 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
                .ok_or_else(|| std::io::Error::other("test application signature missing"))?;
            Ok::<_, std::io::Error>(format!("cdhash:{hash}"))
        })
        .collect::<std::io::Result<Vec<_>>>()?
        .join(",");
    super::test_keychain::run(
        home,
        &[
            "set-generic-password-partition-list",
            "-s",
            key.service(),
            "-a",
            key.account(),
            "-S",
            &partitions,
            "-k",
            super::test_keychain::PASSWORD,
        ],
        &path,
    )
}

#[cfg(not(target_os = "macos"))]
fn seed(
    home: &Path,
    key: &SecretKey,
    fixture: &str,
    _applications: &[&Path],
) -> std::io::Result<()> {
    super::test_keychain::test_store(home)
        .map_err(|_| std::io::Error::other("test store open failed"))?
        .set(key, fixture)
        .map_err(|_| std::io::Error::other("test keychain seed failed"))
}
