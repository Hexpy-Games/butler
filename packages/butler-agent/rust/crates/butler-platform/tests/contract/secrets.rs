//! The credential stores (#217): the owner-only file on every host, and the
//! system store (Keychain, Secret Service, Credential Manager) only when
//! asked for.
//!
//! CI never touches a real credential store. To check this machine's store
//! locally, run from `packages/butler-agent/rust`:
//! `BUTLER_PLATFORM_SYSTEM_SECRETS=1 cargo test -p butler-platform --test contract secrets`.
//! It writes, reads and deletes one throwaway item under its own service
//! (`com.hexpy.butler.contract-test`), which a guard deletes even when an
//! assertion fails. On macOS that is the login Keychain; on Linux it needs a
//! D-Bus session with a Secret Service (GNOME Keyring, KWallet); on Windows
//! the Credential Manager.

use std::fs;
use std::time::Duration;

use butler_platform::secrets::{
    ChangeLock, SYSTEM_BACKEND, SecretBackend, SecretError, SecretKey, SecretStore,
    SecretStoreMode, developer_id_signed,
};
use butler_platform::secure_fs::{OWNER_ONLY, is_owner_only};

use super::scratch;

/// The service the system-store check writes under; never a product one.
const TEST_SERVICE: &str = "com.hexpy.butler.contract-test";

/// Security: a credential store keeps, replaces and deletes one key at a
/// time and never prints a secret. The owner-only file (every host) and the
/// folders it creates are only the owner's, a damaged file is an error
/// (never an empty store), and its change lock excludes a second holder. A
/// test build is not Developer ID signed, so the product never picks the
/// system store for it. With `BUTLER_PLATFORM_SYSTEM_SECRETS=1` the host's
/// system store is checked too (see the module documentation); CI leaves it
/// unset. Also pins the mode and backend names callers report.
// test-category: security
#[test]
fn secret_stores_keep_replace_and_delete_one_key() {
    for (value, mode) in [
        ("file", Some(SecretStoreMode::File)),
        (" System ", Some(SecretStoreMode::System)),
        ("keychain", None),
    ] {
        assert_eq!(SecretStoreMode::parse(value), mode, "{value:?}");
    }
    assert_eq!(SecretStoreMode::default(), SecretStoreMode::File);
    for backend in [
        SecretBackend::Keychain,
        SecretBackend::SecretService,
        SecretBackend::CredentialManager,
        SecretBackend::FallbackFile,
    ] {
        assert_eq!(SecretBackend::from_name(backend.as_str()), Some(backend));
    }
    assert!(SYSTEM_BACKEND.is_system());
    assert!(
        !developer_id_signed(),
        "a test build is not Developer ID signed"
    );
    file_store_keeps_owner_only_secrets_per_key();
    if std::env::var_os("BUTLER_PLATFORM_SYSTEM_SECRETS").is_some_and(|value| value == "1") {
        system_store_keeps_and_deletes_a_secret();
    }
}

fn file_store_keeps_owner_only_secrets_per_key() {
    assert!(matches!(
        SecretKey::new(TEST_SERVICE, ""),
        Err(SecretError::InvalidKey("account"))
    ));
    assert!(SecretKey::new(TEST_SERVICE, "openai/a\nb").is_err());

    let folder = scratch("secrets");
    let path = folder.join("auth/credential-store.json");
    let store = SecretStore::file(path.clone());
    assert_eq!(store.backend(), SecretBackend::FallbackFile);
    let first = SecretKey::new(TEST_SERVICE, "openai/cred_1").unwrap();
    let second = SecretKey::new(TEST_SERVICE, "anthropic/cred_2").unwrap();
    assert!(store.get(&first).unwrap().is_none());
    assert!(!store.delete(&first).unwrap());

    store.set(&first, "sk-first").unwrap();
    store.set(&second, "sk-second").unwrap();
    store.set(&first, "sk-first-replaced").unwrap();
    let read = store.get(&first).unwrap().unwrap();
    assert_eq!(read.expose(), "sk-first-replaced");
    assert!(!format!("{read:?}").contains("sk-first"));
    if OWNER_ONLY {
        assert_eq!(is_owner_only(&fs::metadata(&path).unwrap()), Some(true));
        let auth = fs::metadata(path.parent().unwrap()).unwrap();
        assert_eq!(is_owner_only(&auth), Some(true));
    }

    assert!(store.delete(&first).unwrap());
    assert!(store.get(&first).unwrap().is_none());
    assert_eq!(store.get(&second).unwrap().unwrap().expose(), "sk-second");

    // A change waits for the lock another holder has, and gives up in time.
    let lock_path = folder.join("auth/credential-store.json.lock");
    let held = ChangeLock::acquire(&lock_path, Duration::from_secs(1)).unwrap();
    let waited = ChangeLock::acquire(&lock_path, Duration::from_millis(50)).unwrap_err();
    assert_eq!(waited.kind(), std::io::ErrorKind::TimedOut);
    drop(held);
    ChangeLock::acquire(&lock_path, Duration::from_millis(50)).unwrap();

    fs::write(&path, "{\"secrets\": [").unwrap();
    assert!(matches!(
        store.get(&second),
        Err(SecretError::FileFormat(_))
    ));
    fs::write(&path, "{\"version\": 2, \"secrets\": []}").unwrap();
    assert!(matches!(store.get(&second), Err(SecretError::FileShape)));
    assert!(store.set(&second, "sk-other").is_err());
    fs::remove_dir_all(folder).unwrap();
}

/// Deletes the test item when dropped, so a failed assertion leaves nothing
/// behind in the user's store.
struct RemoveOnDrop<'a>(&'a SecretStore, &'a SecretKey);

impl Drop for RemoveOnDrop<'_> {
    fn drop(&mut self) {
        let _ = self.0.delete(self.1);
    }
}

fn system_store_keeps_and_deletes_a_secret() {
    let store = SecretStore::system().unwrap();
    assert_eq!(store.backend(), SYSTEM_BACKEND);
    let account = format!("contract-test/{}", std::process::id());
    let key = SecretKey::new(TEST_SERVICE, &account).unwrap();
    let _cleanup = RemoveOnDrop(&store, &key);
    let _ = store.delete(&key);
    assert!(store.get(&key).unwrap().is_none());
    store.set(&key, "sk-contract-one").unwrap();
    store.set(&key, "sk-contract-two").unwrap();
    assert_eq!(
        store.get(&key).unwrap().unwrap().expose(),
        "sk-contract-two"
    );
    assert!(store.delete(&key).unwrap());
    assert!(store.get(&key).unwrap().is_none());
    assert!(!store.delete(&key).unwrap());
}
