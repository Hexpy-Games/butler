//! Unlock paths: the locked state, the master password, the keychain, devices.
use super::{Fixture, Folder, Outcome, PASSWORD, contains, files_under, item, password, secret};
use age::secrecy::SecretString;
use butler_e2e::e2e::binary::fixture_binary;
use butler_platform::process_control::fixture_profile_environment;
use butler_platform::secrets::{
    SecretKey, SecretStore, delete_system_secret_for_test, isolated_system_secret_present_for_test,
    prepare_system_keychain_for_test,
};
use butler_vault::vault::{
    KeychainSlot, MIN_PASSWORD_CHARS, Vault, VaultError, VaultPaths, VaultState,
};
use std::path::Path;
use std::process::Command;

#[test]
fn a_locked_vault_refuses_everything_until_unlocked() -> Outcome {
    butler_e2e::gate!();
    let fixture = Fixture::new()?;
    fixture.vault.put(item("site", "the-secret"))?;
    assert_eq!(fixture.vault.state()?, VaultState::Unlocked);

    fixture.vault.lock();
    assert_eq!(fixture.vault.state()?, VaultState::Locked);
    let export = fixture.folder.path().join("export.age");
    assert!(matches!(fixture.vault.read(), Err(VaultError::Locked)));
    assert!(matches!(fixture.vault.get("site"), Err(VaultError::Locked)));
    assert!(matches!(
        fixture.vault.put(item("new", "x")),
        Err(VaultError::Locked)
    ));
    assert!(matches!(
        fixture.vault.delete("site"),
        Err(VaultError::Locked)
    ));
    assert!(matches!(
        fixture.vault.export(&export, &password()),
        Err(VaultError::Locked)
    ));
    assert!(matches!(
        fixture.vault.set_password(&password()),
        Err(VaultError::Locked)
    ));
    assert!(!export.exists());

    fixture.vault.unlock_with_password(&password())?;
    assert_eq!(fixture.vault.get("site")?.unwrap().expose(), "the-secret");
    Ok(())
}

#[test]
fn a_new_handle_starts_locked_and_an_empty_folder_is_absent() -> Outcome {
    butler_e2e::gate!();
    let fixture = Fixture::new()?;
    assert_eq!(
        Vault::new(fixture.paths.clone()).state()?,
        VaultState::Locked
    );

    let empty = Folder::new()?;
    let vault = Vault::new(VaultPaths::in_data_root(empty.path()));
    assert_eq!(vault.state()?, VaultState::Absent);
    assert!(matches!(
        vault.unlock_with_password(&password()),
        Err(VaultError::NoKey)
    ));
    Ok(())
}

// test-category: security
#[test]
fn a_wrong_password_stays_locked_and_changing_it_rewrites_only_the_key_file() -> Outcome {
    butler_e2e::gate!();
    let fixture = Fixture::new()?;
    fixture.vault.put(item("site", "the-secret"))?;
    let vault_bytes = std::fs::read(fixture.paths.file())?;
    fixture.vault.lock();

    assert!(matches!(
        fixture
            .vault
            .unlock_with_password(&secret("not the password at all")),
        Err(VaultError::WrongPassword)
    ));
    assert_eq!(fixture.vault.state()?, VaultState::Locked);

    fixture.vault.unlock_with_password(&password())?;
    let changed = secret("a different long password");
    fixture.vault.set_password(&changed)?;
    assert_eq!(std::fs::read(fixture.paths.file())?, vault_bytes);

    fixture.vault.lock();
    assert!(matches!(
        fixture.vault.unlock_with_password(&password()),
        Err(VaultError::WrongPassword)
    ));
    fixture.vault.unlock_with_password(&changed)?;
    assert_eq!(fixture.vault.get("site")?.unwrap().expose(), "the-secret");
    Ok(())
}

// test-category: security
#[test]
fn a_changed_key_file_refuses_and_short_passwords_are_refused() -> Outcome {
    butler_e2e::gate!();
    let fixture = Fixture::new()?;
    let wrapped = std::fs::read(fixture.paths.key_file())?;
    let mut bad = wrapped.clone();
    *bad.last_mut().unwrap() ^= 1;
    std::fs::write(fixture.paths.key_file(), &bad)?;
    let second = Vault::new(fixture.paths.clone());
    assert!(matches!(
        second.unlock_with_password(&password()),
        Err(VaultError::Refused)
    ));
    std::fs::write(fixture.paths.key_file(), &wrapped)?;

    let short = secret(&"x".repeat(MIN_PASSWORD_CHARS - 1));
    assert!(matches!(
        fixture.vault.set_password(&short),
        Err(VaultError::WeakPassword)
    ));
    assert!(matches!(
        fixture
            .vault
            .export(&fixture.folder.path().join("e.age"), &short),
        Err(VaultError::WeakPassword)
    ));
    let empty = Folder::new()?;
    assert!(matches!(
        Vault::new(VaultPaths::in_folder(empty.path())).create_with_password(&short),
        Err(VaultError::WeakPassword)
    ));
    Ok(())
}

// test-category: format-pin
#[test]
fn age_refuses_a_password_recipient_next_to_x25519() -> Outcome {
    butler_e2e::gate!();
    // Why the password wraps the identity instead of being a second recipient.
    let device = age::x25519::Identity::generate().to_public();
    let password = age::scrypt::Recipient::new(SecretString::from(PASSWORD.to_owned()));
    let recipients: [&dyn age::Recipient; 2] = [&device, &password];
    assert!(matches!(
        age::Encryptor::with_recipients(recipients.into_iter()),
        Err(age::EncryptError::MixedRecipientAndPassphrase)
    ));
    Ok(())
}

#[test]
fn an_added_device_opens_the_same_vault_and_both_keep_saving() -> Outcome {
    butler_e2e::gate!();
    let first = Fixture::new()?;
    let second = Fixture::new()?;
    first.vault.put(item("site", "the-secret"))?;
    let wrapped = std::fs::read(first.paths.key_file())?;

    first
        .vault
        .add_recipient(&second.vault.device_recipient()?)?;
    assert_eq!(std::fs::read(first.paths.key_file())?, wrapped);
    let header = std::fs::read(first.paths.file())?;
    let header = String::from_utf8_lossy(&header[..header.len().min(600)]).into_owned();
    assert_eq!(header.matches("-> X25519 ").count(), 2);

    std::fs::copy(first.paths.file(), second.paths.file())?;
    assert_eq!(second.vault.get("site")?.unwrap().expose(), "the-secret");
    second.vault.put(item("from-second", "2"))?;

    std::fs::copy(second.paths.file(), first.paths.file())?;
    assert_eq!(first.vault.get("from-second")?.unwrap().expose(), "2");
    assert_eq!(first.vault.read()?.recipients.len(), 2);

    assert!(matches!(
        first.vault.add_recipient("age1notakey"),
        Err(VaultError::InvalidRecipient)
    ));
    Ok(())
}

// test-category: security
#[test]
fn the_keychain_path_refuses_a_file_store() -> Outcome {
    butler_e2e::gate!();
    let folder = Folder::new()?;
    let store = SecretStore::file(folder.path().join("secrets.json"));
    assert!(matches!(
        KeychainSlot::new(store, folder.path()),
        Err(VaultError::NotSystemStore)
    ));
    Ok(())
}

// test-category: security
#[test]
fn the_keychain_opens_the_vault_after_a_restart_and_the_last_path_stays() -> Outcome {
    butler_e2e::gate!();
    let folder = Folder::new()?;
    let home = folder.path().join("home");
    let data = folder.path().join("data");
    let store = folder.path().join("tmp/test-secrets/store.json");
    std::fs::create_dir_all(&home)?;
    std::fs::create_dir_all(&data)?;
    std::fs::create_dir_all(store.parent().unwrap())?;
    prepare_system_keychain_for_test(&home)?;
    let run = |step: &str| -> Result<String, Box<dyn std::error::Error>> {
        let output = Command::new(fixture_binary("e2e-vault")?)
            .arg(step)
            .arg(&data)
            .current_dir(&home)
            .env("HOME", &home)
            .envs(fixture_profile_environment(&home))
            .env("BUTLER_TEST_SECRET_STORE", &store)
            .output()?;
        assert!(
            output.status.success(),
            "{step}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        Ok(String::from_utf8(output.stdout)?.trim().to_owned())
    };
    let service = run("keychain-create")?;
    let key = SecretKey::new(&service, "device-identity")?;
    let result = keychain_steps(&run, &home, &data, &key);
    delete_system_secret_for_test(&home, &key)?;
    result
}

type Step<'a> = dyn Fn(&str) -> Result<String, Box<dyn std::error::Error>> + 'a;

fn keychain_steps(run: &Step<'_>, home: &Path, data: &Path, key: &SecretKey) -> Outcome {
    assert!(isolated_system_secret_present_for_test(home, key)?);
    run("keychain-reopen")?;
    run("keychain-last-path")?;
    // No key file was ever left beside the ciphertext in keychain mode.
    let paths = VaultPaths::in_data_root(data);
    assert!(!paths.key_file().exists());
    for (path, bytes) in files_under(data)? {
        assert!(!contains(&bytes, b"AGE-SECRET-KEY"), "{}", path.display());
    }
    Ok(())
}
