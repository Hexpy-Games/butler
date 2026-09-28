//! The credential store (#217): the owner-only fallback file on every host,
//! and the system store (Keychain, Secret Service, Credential Manager) only
//! when asked for.
//!
//! CI never touches a real credential store. To check this machine's store
//! locally (it writes, reads and deletes one throwaway item under the
//! `Butler` service), run from `packages/butler-agent/rust`:
//! `BUTLER_PLATFORM_SYSTEM_SECRETS=1 cargo test -p butler-platform --test contract secrets`.
//! On macOS that is the login Keychain; on Linux it needs a D-Bus session
//! with a Secret Service (GNOME Keyring, KWallet); on Windows the Credential
//! Manager.

use std::fs;

use butler_platform::secrets::{
    SERVICE, SecretBackend, SecretError, SecretKey, SecretStore, SecretStoreMode,
};
use butler_platform::secure_fs::{OWNER_ONLY, is_owner_only};

use super::scratch;

/// Security: a credential store keeps, replaces and deletes one key at a
/// time and never prints a secret. The owner-only fallback file (every host)
/// and the folders it creates are only the owner's, and a damaged file is an
/// error, never an empty store. With `BUTLER_PLATFORM_SYSTEM_SECRETS=1` the
/// host's system store is checked too (see the module documentation); CI
/// leaves it unset. Also pins the mode and backend names callers report.
// test-category: security
#[test]
fn secret_stores_keep_replace_and_delete_one_key() {
    file_store_keeps_owner_only_secrets_per_key();
    if std::env::var_os("BUTLER_PLATFORM_SYSTEM_SECRETS").is_some_and(|value| value == "1") {
        system_store_keeps_and_deletes_a_secret();
    }
}

fn file_store_keeps_owner_only_secrets_per_key() {
    for (setting, mode) in [
        (None, SecretStoreMode::System),
        (Some("file"), SecretStoreMode::File),
        (Some(" FILE "), SecretStoreMode::File),
        (Some("keychain"), SecretStoreMode::System),
    ] {
        assert_eq!(SecretStoreMode::from_setting(setting), mode, "{setting:?}");
    }
    for backend in [
        SecretBackend::Keychain,
        SecretBackend::SecretService,
        SecretBackend::CredentialManager,
        SecretBackend::FallbackFile,
    ] {
        assert_eq!(SecretBackend::from_name(backend.as_str()), Some(backend));
    }
    assert!(matches!(
        SecretKey::new(SERVICE, ""),
        Err(SecretError::InvalidKey("account"))
    ));
    assert!(SecretKey::new(SERVICE, "openai/a\nb").is_err());

    let folder = scratch("secrets");
    let path = folder.join("auth/credential-store.json");
    let store = SecretStore::file(path.clone());
    assert_eq!(store.backend(), SecretBackend::FallbackFile);
    let first = SecretKey::new(SERVICE, "openai/cred_1").unwrap();
    let second = SecretKey::new(SERVICE, "anthropic/cred_2").unwrap();
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

fn system_store_keeps_and_deletes_a_secret() {
    let store = SecretStore::system().unwrap();
    let expected = if cfg!(target_os = "macos") {
        SecretBackend::Keychain
    } else if cfg!(windows) {
        SecretBackend::CredentialManager
    } else {
        SecretBackend::SecretService
    };
    assert_eq!(store.backend(), expected);
    let account = format!("contract-test/{}", std::process::id());
    let key = SecretKey::new(SERVICE, &account).unwrap();
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
