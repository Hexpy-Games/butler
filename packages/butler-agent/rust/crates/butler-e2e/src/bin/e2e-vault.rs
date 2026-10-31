//! Drives `butler-vault` from a process of its own, for the scenarios that need
//! a real restart or a real kill (`tests/vault.rs`).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "fixture assertions"
)]
use butler_platform::secrets::{SecretStore, SecretText};
use butler_vault::vault::{
    ItemKind, KeychainSlot, NewItem, Vault, VaultError, VaultPaths, VaultState,
};
use std::io::Write;
use std::path::Path;

const CANARY: &str = "e2e-vault-secret";
const PASSWORD: &str = "the keychain scenario's password";

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = Path::new(&args[2]);
    match args[1].as_str() {
        "write" => write(path, &args[3], &args[4]),
        "keychain-create" => keychain_create(path),
        "keychain-reopen" => keychain_reopen(path),
        "keychain-last-path" => keychain_last_path(path),
        "keychain-race" => keychain_race(path),
        "keychain-stale" => keychain_stale(path),
        other => panic!("unknown step {other}"),
    }
}

fn item(id: &str) -> NewItem {
    NewItem {
        id: id.to_owned(),
        kind: ItemKind::Signin,
        value: SecretText::new(CANARY.to_owned()),
    }
}

/// Saves until killed, printing each item's id once its save has returned.
fn write(folder: &Path, password: &str, round: &str) {
    let vault = Vault::new(VaultPaths::in_folder(folder));
    vault
        .unlock_with_password(&SecretText::new(password.to_owned()))
        .unwrap();
    let mut stdout = std::io::stdout();
    let mut index = 0_u64;
    loop {
        let id = format!("round-{round}-{index}");
        vault.put(item(&id)).unwrap();
        writeln!(stdout, "{id}").unwrap();
        stdout.flush().unwrap();
        index += 1;
    }
}

fn slot(data: &Path) -> KeychainSlot {
    KeychainSlot::new(SecretStore::system().unwrap(), data).unwrap()
}

fn vault_in(data: &Path) -> Vault {
    Vault::new(VaultPaths::in_data_root(data))
}

fn keychain_create(data: &Path) {
    // A folder that does not exist yet has no stable slot name.
    assert!(matches!(
        KeychainSlot::new(SecretStore::system().unwrap(), &data.join("not-yet")),
        Err(VaultError::Io(_))
    ));
    let slot = slot(data);
    let vault = vault_in(data);
    assert_eq!(vault.state().unwrap(), VaultState::Absent);
    vault.create_with_keychain(&slot).unwrap();
    vault.put(item("site")).unwrap();
    assert!(matches!(
        vault.create_with_keychain(&slot),
        Err(VaultError::AlreadyExists)
    ));
    println!("{}", slot.key().service());
}

fn keychain_reopen(data: &Path) {
    let vault = vault_in(data);
    assert_eq!(vault.state().unwrap(), VaultState::Locked);
    assert!(matches!(vault.get("site"), Err(VaultError::Locked)));
    vault.unlock_with_keychain(&slot(data)).unwrap();
    assert_eq!(vault.get("site").unwrap().unwrap().expose(), CANARY);
}

/// Neither path can be removed while it is the only one left.
fn keychain_last_path(data: &Path) {
    let password = SecretText::new(PASSWORD.to_owned());
    let wrong = SecretText::new("not the scenario's password".to_owned());
    let slot = slot(data);
    let vault = vault_in(data);
    vault.unlock_with_keychain(&slot).unwrap();
    assert!(!vault.has_password().unwrap());
    assert!(matches!(
        vault.remove_from_keychain(&slot, &password),
        Err(VaultError::LastUnlockPath)
    ));

    vault.set_password(&password).unwrap();
    assert!(vault.has_password().unwrap());
    assert!(matches!(
        vault.remove_from_keychain(&slot, &wrong),
        Err(VaultError::WrongPassword)
    ));
    vault.unlock_with_keychain(&slot).unwrap();

    vault.remove_from_keychain(&slot, &password).unwrap();
    assert!(matches!(
        vault.unlock_with_keychain(&slot),
        Err(VaultError::NoKey)
    ));
    assert!(matches!(
        vault.remove_password(&slot),
        Err(VaultError::LastUnlockPath)
    ));
    assert!(vault.has_password().unwrap());
    let reopened = vault_in(data);
    reopened.unlock_with_password(&password).unwrap();
    assert_eq!(reopened.get("site").unwrap().unwrap().expose(), CANARY);

    vault.add_to_keychain(&slot).unwrap();
    vault.remove_password(&slot).unwrap();
    assert!(!vault.has_password().unwrap());
    let reopened = vault_in(data);
    reopened.unlock_with_keychain(&slot).unwrap();
    assert_eq!(reopened.get("site").unwrap().unwrap().expose(), CANARY);
}

/// Removing each unlock path at once from two handles must leave one standing.
fn keychain_race(data: &Path) {
    let password = SecretText::new(PASSWORD.to_owned());
    for round in 0..3 {
        let vault = vault_in(data);
        match vault.unlock_with_keychain(&slot(data)) {
            Ok(()) => vault.set_password(&password).unwrap(),
            Err(VaultError::NoKey) => {
                vault.unlock_with_password(&password).unwrap();
                vault.add_to_keychain(&slot(data)).unwrap();
            }
            Err(error) => panic!("round {round}: {error}"),
        }
        let other = vault_in(data);
        other.unlock_with_password(&password).unwrap();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                let _ = vault.remove_from_keychain(&slot(data), &password);
            });
            scope.spawn(|| {
                // Lands inside the first call's password check.
                std::thread::sleep(std::time::Duration::from_millis(50));
                let _ = other.remove_password(&slot(data));
            });
        });
        let by_keychain = vault_in(data).unlock_with_keychain(&slot(data)).is_ok();
        let by_password = vault_in(data).unlock_with_password(&password).is_ok();
        assert!(
            by_keychain || by_password,
            "round {round} left no unlock path"
        );
    }
    let vault = vault_in(data);
    vault
        .unlock_with_keychain(&slot(data))
        .or_else(|_| vault.unlock_with_password(&password))
        .unwrap();
    vault.add_to_keychain(&slot(data)).unwrap();
    vault.remove_password(&slot(data)).unwrap();
}

/// A keychain item left from an earlier vault must neither unlock this one nor
/// count as a second way in.
fn keychain_stale(data: &Path) {
    let password = SecretText::new(PASSWORD.to_owned());
    let paths = VaultPaths::in_data_root(data);
    std::fs::remove_file(paths.file()).unwrap();
    std::fs::remove_file(paths.previous()).unwrap();
    let vault = Vault::new(paths.clone());
    vault.create_with_password(&password).unwrap();
    vault.put(item("site")).unwrap();

    let stale = Vault::new(paths.clone());
    assert!(matches!(
        stale.unlock_with_keychain(&slot(data)),
        Err(VaultError::Refused)
    ));
    assert_eq!(stale.state().unwrap(), VaultState::Locked);
    assert!(matches!(
        vault.remove_password(&slot(data)),
        Err(VaultError::LastUnlockPath)
    ));
    assert!(vault.has_password().unwrap());
    let reopened = Vault::new(paths);
    reopened.unlock_with_password(&password).unwrap();
    assert_eq!(reopened.get("site").unwrap().unwrap().expose(), CANARY);
}
