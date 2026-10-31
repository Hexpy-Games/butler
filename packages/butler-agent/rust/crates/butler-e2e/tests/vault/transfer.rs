//! Password-protected export and import.
use super::{
    Fixture, Outcome, PASSWORD, contains, item, open_with_password, password, secret,
    without_hanging,
};
use age::secrecy::SecretString;
use serde_json::json;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

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

/// An export written directly, at a low work factor to keep the scenario fast.
fn write_export(payload: &Value, path: &Path) -> Outcome {
    let mut recipient = age::scrypt::Recipient::new(SecretString::from(PASSWORD.to_owned()));
    recipient.set_work_factor(10);
    let sealed = age::encrypt(&recipient, serde_json::to_vec(payload)?.as_slice())?;
    std::fs::write(path, sealed)?;
    Ok(())
}

fn now_ms() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap()
}

// test-category: security
#[test]
fn an_import_with_times_over_a_day_ahead_is_refused() -> Outcome {
    butler_e2e::gate!();
    const DAY: u64 = 86_400_000;
    let fixture = Fixture::new()?;
    fixture.vault.put(item("site", "local"))?;
    let before = fixture.vault.read()?;
    let file = fixture.folder.path().join("export.age");
    let ahead = now_ms() + 2 * DAY;
    let edit = |time: u64| json!({"id": "site", "kind": "card", "updated_at": time, "device": "z", "value": "export"});
    let export = |items: Value, tombstones: Value| {
        json!({"format": 1, "vault_id": "x", "seq": u64::MAX, "recipients": [],
               "items": items, "tombstones": tombstones})
    };
    for bad in [
        export(json!([edit(ahead)]), json!([])),
        export(json!([edit(u64::MAX)]), json!([])),
        export(json!([]), json!([{"id": "site", "deleted_at": ahead}])),
    ] {
        write_export(&bad, &file)?;
        assert!(matches!(
            fixture.vault.import(&file, &password()),
            Err(VaultError::TimeAhead)
        ));
        assert_eq!(fixture.vault.read()?, before);
    }
    // A clock a little ahead is ordinary.
    write_export(&export(json!([edit(now_ms() + DAY / 2)]), json!([])), &file)?;
    assert!(fixture.vault.import(&file, &password())?);
    assert_eq!(fixture.vault.get("site")?.unwrap().expose(), "export");
    Ok(())
}

#[test]
fn repeating_an_import_with_expired_tombstones_changes_nothing() -> Outcome {
    butler_e2e::gate!();
    let fixture = Fixture::new()?;
    fixture.vault.put(item("site", "1"))?;
    let file = fixture.folder.path().join("export.age");
    write_export(
        &json!({"format": 1, "vault_id": "x", "seq": 1, "recipients": [], "items": [],
                "tombstones": [{"id": "old", "deleted_at": 1000}]}),
        &file,
    )?;
    let seq = fixture.vault.read()?.seq;
    assert!(!fixture.vault.import(&file, &password())?);
    assert!(!fixture.vault.import(&file, &password())?);
    assert_eq!(fixture.vault.read()?.seq, seq);
    Ok(())
}

// test-category: security
#[test]
fn an_import_reads_only_ordinary_files() -> Outcome {
    butler_e2e::gate!();
    let fixture = Fixture::new()?;
    assert!(matches!(
        fixture.vault.import(fixture.folder.path(), &password()),
        Err(VaultError::Refused)
    ));
    // Where the host has FIFOs: reading one would wait for a writer forever.
    let fifo = fixture.folder.path().join("pipe.age");
    let made = std::process::Command::new("mkfifo").arg(&fifo).status();
    if made.is_ok_and(|status| status.success()) {
        let answer = without_hanging(move || fixture.vault.import(&fifo, &password()));
        assert!(matches!(answer, Err(VaultError::Refused)), "{answer:?}");
    }
    Ok(())
}

// test-category: security
#[test]
fn an_export_into_the_vault_folder_is_refused() -> Outcome {
    butler_e2e::gate!();
    let fixture = Fixture::new()?;
    fixture.vault.put(item("site", "1"))?;
    let folder = fixture.paths.file().parent().unwrap().to_path_buf();
    let before = std::fs::read(fixture.paths.file())?;
    for destination in [
        fixture.paths.file().to_path_buf(),
        fixture.paths.previous().to_path_buf(),
        fixture.paths.key_file().to_path_buf(),
        folder.join("export.age"),
    ] {
        assert!(matches!(
            fixture.vault.export(&destination, &password()),
            Err(VaultError::ExportInsideVault)
        ));
    }
    assert_eq!(std::fs::read(fixture.paths.file())?, before);
    assert!(!folder.join("export.age").exists());
    fixture.vault.read()?;
    Ok(())
}
