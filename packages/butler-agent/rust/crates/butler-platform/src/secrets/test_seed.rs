//! Seed a suffixed test service for the exact binaries exercising a migration.
use super::SecretKey;
use std::path::Path;

/// Test fixtures created by one unsigned binary must also be readable by the
/// unsigned Agent binary. This does not change any product credential's ACL.
pub fn seed_system_secret_for_test_apps(
    key: &SecretKey,
    fixture: &str,
    applications: &[&Path],
) -> std::io::Result<()> {
    let suffix = key.service().rsplit('.').next().unwrap_or("");
    if !key.service().starts_with("com.hexpy.butler.")
        || suffix.len() != 12
        || !suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
        || applications.is_empty()
        || applications.iter().any(|path| !path.is_absolute())
    {
        return Err(std::io::Error::other(
            "a suffixed test service and exact applications are required",
        ));
    }
    seed(key, fixture, applications)
}

#[cfg(target_os = "macos")]
fn seed(key: &SecretKey, fixture: &str, applications: &[&Path]) -> std::io::Result<()> {
    let mut command = std::process::Command::new("/usr/bin/security");
    command.args([
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
    let output = command.output()?;
    if output.status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other("test keychain seed failed"))
    }
}

#[cfg(not(target_os = "macos"))]
fn seed(key: &SecretKey, fixture: &str, _applications: &[&Path]) -> std::io::Result<()> {
    super::SecretStore::system()
        .and_then(|store| store.set(key, fixture))
        .map_err(|_| std::io::Error::other("test keychain seed failed"))
}
