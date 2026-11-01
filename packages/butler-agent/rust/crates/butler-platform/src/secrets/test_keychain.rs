//! Disposable keychains belong to a fresh test HOME, never the owner's search list.
use super::SecretKey;
#[cfg(not(target_os = "macos"))]
use super::SecretStore;
use crate::secure_fs::{Canonical, is_within, same_path};
use std::path::Path;

#[cfg(target_os = "macos")]
pub(super) const PASSWORD: &str = "butler-e2e-fixture";

/// Creates a keychain with a fixture password inside a fresh temporary HOME.
pub fn prepare_system_keychain_for_test(home: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        temporary_home(home)?;
        let directory = home.join("Library/Keychains");
        if !home.is_absolute() || directory.try_exists()? {
            return Err(std::io::Error::other(
                "a fresh absolute test home is required",
            ));
        }
        std::fs::create_dir_all(&directory)?;
        std::fs::create_dir_all(home.join("Library/Preferences"))?;
        let path = directory.join("butler-test.keychain-db");
        run(home, &["create-keychain", "-p", PASSWORD], &path)?;
        run(home, &["default-keychain", "-d", "user", "-s"], &path)?;
        run(home, &["unlock-keychain", "-p", PASSWORD], &path)?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = home;
    Ok(())
}

#[cfg(target_os = "macos")]
pub(super) fn path(home: &Path) -> std::io::Result<std::path::PathBuf> {
    temporary_home(home)?;
    let directory = home.join("Library/Keychains");
    if !home.is_absolute()
        || std::fs::symlink_metadata(&directory)?
            .file_type()
            .is_symlink()
    {
        return Err(std::io::Error::other(
            "an isolated test keychain is required",
        ));
    }
    if !is_within(&directory.canonical()?, &home.canonical()?) {
        return Err(std::io::Error::other(
            "an isolated test keychain is required",
        ));
    }
    Ok(directory.join("butler-test.keychain-db"))
}

#[cfg(target_os = "macos")]
pub(super) fn run(home: &Path, args: &[&str], path: &Path) -> std::io::Result<()> {
    let output = std::process::Command::new("/usr/bin/security")
        .env("HOME", home)
        .args(args)
        .arg(path)
        .output()?;
    if output.status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other(format!(
            "test keychain {} failed ({})",
            args.first().copied().unwrap_or("operation"),
            output.status
        )))
    }
}

/// Checks metadata only; the test process does not read an Agent-created secret.
pub fn system_secret_present_for_test(home: &Path, key: &SecretKey) -> std::io::Result<bool> {
    require_test_service(key)?;
    isolated_system_secret_present_for_test(home, key)
}

/// Checks metadata in an explicitly isolated temporary keychain.
pub fn isolated_system_secret_present_for_test(
    home: &Path,
    key: &SecretKey,
) -> std::io::Result<bool> {
    #[cfg(target_os = "macos")]
    {
        let query = query(home, key)?;
        match query.search() {
            Ok(items) => Ok(!items.is_empty()),
            Err(error) if error.code() == -25300 => Ok(false),
            Err(_) => Err(std::io::Error::other("test keychain lookup failed")),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let store = test_store(home)?;
        store
            .get(key)
            .map(|value| value.is_some())
            .map_err(|_| std::io::Error::other("test keychain lookup failed"))
    }
}

/// Deletes only the scenario's suffixed fixture key, including on test failure.
pub fn delete_system_secret_for_test(home: &Path, key: &SecretKey) -> std::io::Result<()> {
    require_test_service(key)?;
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/usr/bin/security")
            .env("HOME", home)
            .args([
                "delete-generic-password",
                "-s",
                key.service(),
                "-a",
                key.account(),
            ])
            .arg(path(home)?)
            .output()?;
        // security's 44 is errSecItemNotFound, including a migrated legacy key.
        if !output.status.success() && output.status.code() != Some(44) {
            return Err(std::io::Error::other("test keychain cleanup failed"));
        }
        if system_secret_present_for_test(home, key)? {
            return Err(std::io::Error::other("test keychain item remains"));
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let store = test_store(home)?;
        store
            .delete(key)
            .map(|_| ())
            .map_err(|_| std::io::Error::other("test keychain cleanup failed"))
    }
}

#[cfg(target_os = "macos")]
fn query(
    home: &Path,
    key: &SecretKey,
) -> std::io::Result<security_framework::item::ItemSearchOptions> {
    use security_framework::{
        item::{ItemClass, ItemSearchOptions},
        os::macos::keychain::SecKeychain,
    };
    let chain = SecKeychain::open(path(home)?)
        .map_err(|_| std::io::Error::other("test keychain open failed"))?;
    let mut query = ItemSearchOptions::new();
    query
        .keychains(&[chain])
        .class(ItemClass::generic_password())
        .service(key.service())
        .account(key.account());
    Ok(query)
}

#[cfg(target_os = "macos")]
fn temporary_home(home: &Path) -> std::io::Result<()> {
    let temporary = std::env::temp_dir().canonical()?;
    let home = home.canonical()?;
    if same_path(&home, &temporary) || !is_within(&home, &temporary) {
        return Err(std::io::Error::other("a temporary test home is required"));
    }
    Ok(())
}

pub(super) fn test_service(key: &SecretKey) -> bool {
    let suffix = key.service().rsplit('.').next().unwrap_or("");
    key.service().starts_with("com.hexpy.butler.")
        && suffix.len() == 12
        && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn require_test_service(key: &SecretKey) -> std::io::Result<()> {
    if test_service(key) {
        Ok(())
    } else {
        Err(std::io::Error::other("a suffixed test service is required"))
    }
}

#[cfg(not(target_os = "macos"))]
pub(super) fn test_store(home: &Path) -> std::io::Result<SecretStore> {
    let store = super::test_file::for_home(home);
    store.map_err(|_| std::io::Error::other("test secret store open failed"))
}

/// Makes only this temporary scenario's configured credential store unreachable.
/// Retains existing credentials so cleanup tests can check the pending keys.
pub fn make_system_keychain_unavailable_for_test(home: &Path) -> std::io::Result<()> {
    let home = home.canonical()?;
    let temporary = std::env::temp_dir().canonical()?;
    if same_path(&home, &temporary) || !is_within(&home, &temporary) {
        return Err(std::io::Error::other("a temporary test home is required"));
    }
    let directory = home
        .parent()
        .ok_or_else(|| std::io::Error::other("test home parent missing"))?
        .join("tmp/test-secrets");
    if directory.exists() {
        std::fs::rename(&directory, directory.with_extension("unavailable"))?;
    }
    std::fs::write(directory, "unavailable")
}

/// Validate the configured fixture-store location even on native-keychain hosts.
#[cfg(target_os = "macos")]
pub(super) fn validate_store_path(path: &Path) -> Result<(), super::SecretError> {
    if path
        .parent()
        .and_then(|p| std::fs::metadata(p).ok())
        .is_some_and(|m| !m.is_dir())
    {
        return Err(super::SecretError::File(std::io::Error::other(
            "credential store directory is unavailable",
        )));
    }
    Ok(())
}
