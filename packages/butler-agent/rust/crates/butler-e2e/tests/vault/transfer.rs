//! Password-protected export and import.
use super::{Fixture, Outcome, PASSWORD, contains, item, open_with_password, password, secret};
use butler_vault::vault::VaultError;
use serde_json::Value;

#[test]
fn an_export_round_trips_into_a_new_vault_on_another_device() -> Outcome {
    butler_e2e::gate!();
    let source = Fixture::new()?;
    source.vault.put(item("site", "the-secret"))?;
    source.vault.put(item("gone", "x"))?;
    source.vault.delete("gone")?;
    let export = source.folder.path().join("export.age");
    source.vault.export(&export, &password())?;

    let target = Fixture::new()?;
    target.vault.put(item("mine", "local"))?;
    assert!(target.vault.import(&export, &password())?);

    let merged = target.vault.read()?;
    let exported = source.vault.read()?;
    assert_eq!(merged.item("site"), exported.item("site"));
    assert_eq!(merged.item("mine").unwrap().value.expose(), "local");
    assert_eq!(merged.tombstones, exported.tombstones);
    // The other device got no access to this vault.
    assert_eq!(merged.recipients.len(), 1);
    assert_eq!(merged.recipients[0], target.vault.device_recipient()?);
    // A second import changes nothing.
    assert!(!target.vault.import(&export, &password())?);
    Ok(())
}

// test-category: format-pin
#[test]
fn an_export_is_a_standard_password_file_with_no_recipients() -> Outcome {
    butler_e2e::gate!();
    let fixture = Fixture::new()?;
    fixture.vault.put(item("site", "the-secret"))?;
    let export = fixture.folder.path().join("export.age");
    fixture.vault.export(&export, &password())?;
    let sealed = std::fs::read(&export)?;
    let header = String::from_utf8_lossy(&sealed[..sealed.len().min(200)]).into_owned();
    assert_eq!(header.matches("-> scrypt ").count(), 1);
    assert!(header.contains(" 18\n"));
    assert!(!contains(&sealed, b"X25519"));
    let payload: Value = serde_json::from_slice(&open_with_password(PASSWORD, &sealed)?)?;
    assert_eq!(payload["recipients"], serde_json::json!([]));
    assert_eq!(payload["items"][0]["value"], "the-secret");
    Ok(())
}

#[test]
fn an_old_export_never_deletes_or_replaces_newer_items() -> Outcome {
    butler_e2e::gate!();
    let fixture = Fixture::new()?;
    fixture.vault.put(item("edited", "old"))?;
    fixture.vault.put(item("deleted", "old"))?;
    fixture.vault.put(item("kept", "old"))?;
    let export = fixture.folder.path().join("export.age");
    fixture.vault.export(&export, &password())?;

    fixture.vault.put(item("edited", "new"))?;
    fixture.vault.delete("deleted")?;
    fixture.vault.put(item("added", "new"))?;
    let before = fixture.vault.read()?;
    assert!(!fixture.vault.import(&export, &password())?);
    let after = fixture.vault.read()?;
    assert_eq!(before, after);
    assert_eq!(after.item("edited").unwrap().value.expose(), "new");
    assert!(after.item("deleted").is_none());
    Ok(())
}

#[test]
fn a_batch_is_one_save() -> Outcome {
    butler_e2e::gate!();
    let fixture = Fixture::new()?;
    let before = fixture.vault.read()?.seq;
    let items = (0..1000)
        .map(|index| item(&format!("site-{index}"), "x"))
        .collect();
    fixture.vault.put_many(items)?;
    let payload = fixture.vault.read()?;
    assert_eq!(payload.seq, before + 1);
    assert_eq!(payload.items.len(), 1000);
    Ok(())
}

// test-category: security
#[test]
fn a_wrong_password_or_another_file_changes_nothing() -> Outcome {
    butler_e2e::gate!();
    let source = Fixture::new()?;
    source.vault.put(item("site", "the-secret"))?;
    let export = source.folder.path().join("export.age");
    source.vault.export(&export, &password())?;

    let target = Fixture::new()?;
    let before = std::fs::read(target.paths.file())?;
    assert!(matches!(
        target
            .vault
            .import(&export, &secret("not the export password")),
        Err(VaultError::WrongPassword)
    ));
    // A vault file is for recipients, not for a password.
    assert!(matches!(
        target.vault.import(source.paths.file(), &password()),
        Err(VaultError::Refused)
    ));
    let mut changed = std::fs::read(&export)?;
    *changed.last_mut().unwrap() ^= 1;
    std::fs::write(&export, &changed)?;
    assert!(matches!(
        target.vault.import(&export, &password()),
        Err(VaultError::Refused)
    ));
    assert_eq!(std::fs::read(target.paths.file())?, before);
    Ok(())
}

// test-category: security
#[test]
fn a_file_demanding_excessive_work_is_refused_before_doing_it() -> Outcome {
    butler_e2e::gate!();
    let fixture = Fixture::new()?;
    let export = fixture.folder.path().join("export.age");
    fixture.vault.export(&export, &password())?;
    // The stanza declares the work, and is checked before any work is done.
    let mut heavy = std::fs::read(&export)?;
    let at = heavy.windows(4).position(|part| part == b" 18\n").unwrap();
    heavy[at + 1..at + 3].copy_from_slice(b"30");
    std::fs::write(&export, heavy)?;
    assert!(matches!(
        fixture.vault.import(&export, &password()),
        Err(VaultError::Refused)
    ));
    Ok(())
}
