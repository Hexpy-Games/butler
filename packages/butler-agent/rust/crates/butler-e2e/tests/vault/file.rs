//! The vault file: format, tampering, saving, crashes and idle behaviour.
use super::{Fixture, Outcome, PASSWORD, contains, files_under, item, password, secret};
use butler_e2e::e2e::binary::fixture_binary;
use butler_platform::secure_fs;
use butler_vault::vault::{ItemKind, Vault, VaultError};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::Instant;

/// Kills the writer on every way out of the scenario.
struct Writer(Child);

impl Drop for Writer {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

// test-category: format-pin
#[test]
fn every_kind_has_its_pinned_name() -> Outcome {
    butler_e2e::gate!();
    for (kind, name) in [
        (ItemKind::Signin, "signin"),
        (ItemKind::Card, "card"),
        (ItemKind::Profile, "profile"),
        (ItemKind::ImportBackup, "import_backup"),
        (ItemKind::ApiKey, "api_key"),
    ] {
        assert_eq!(serde_json::to_value(kind)?, json!(name));
    }
    Ok(())
}

// test-category: format-pin
#[test]
fn save_is_one_x25519_recipient_and_the_pinned_payload() -> Outcome {
    butler_e2e::gate!();
    let fixture = Fixture::new()?;
    fixture.vault.put(item("site", "the-secret"))?;
    fixture.vault.put(item("gone", "x"))?;
    assert!(fixture.vault.delete("gone")?);

    let sealed = std::fs::read(fixture.paths.file())?;
    let header = String::from_utf8_lossy(&sealed[..sealed.len().min(400)]).into_owned();
    assert_eq!(header.matches("-> X25519 ").count(), 1);
    assert!(!header.contains("scrypt"));

    let identity = fixture.identity()?;
    let payload: Value = serde_json::from_slice(&age::decrypt(&identity, &sealed)?)?;
    let device = payload["items"][0]["device"].clone();
    let updated_at = payload["items"][0]["updated_at"].clone();
    let deleted_at = payload["tombstones"][0]["deleted_at"].clone();
    assert_eq!(
        payload,
        json!({
            "format": 1,
            "vault_id": payload["vault_id"],
            "seq": 4,
            "recipients": [identity.to_public().to_string()],
            "items": [{
                "id": "site",
                "kind": "signin",
                "updated_at": updated_at,
                "device": device,
                "value": "the-secret",
            }],
            "tombstones": [{"id": "gone", "deleted_at": deleted_at}],
        })
    );
    assert!(updated_at.is_u64() && deleted_at.is_u64() && device.is_string());
    Ok(())
}

// test-category: security
#[test]
fn any_changed_byte_refuses_and_is_never_overwritten() -> Outcome {
    butler_e2e::gate!();
    let fixture = Fixture::new()?;
    fixture.vault.put(item("site", "the-secret"))?;
    let file = fixture.paths.file();
    let good = std::fs::read(file)?;
    let previous = std::fs::read(fixture.paths.previous())?;
    let refused = |bad: &[u8]| -> Outcome {
        std::fs::write(file, bad)?;
        assert!(matches!(fixture.vault.read(), Err(VaultError::Refused)));
        assert!(matches!(
            fixture.vault.put(item("new", "x")),
            Err(VaultError::Refused)
        ));
        assert_eq!(std::fs::read(file)?, bad);
        assert_eq!(std::fs::read(fixture.paths.previous())?, previous);
        Ok(())
    };
    for index in 0..good.len() {
        for mask in [0x01_u8, 0x80] {
            let mut bad = good.clone();
            bad[index] ^= mask;
            refused(&bad)?;
        }
    }
    let mut longer = good.clone();
    longer.push(0);
    refused(&longer)?;
    for length in [0, 1, good.len() / 2, good.len() - 16, good.len() - 1] {
        refused(&good[..length])?;
    }
    Ok(())
}

// test-category: security
#[test]
fn losing_whole_chunks_refuses_and_another_keys_file_refuses() -> Outcome {
    butler_e2e::gate!();
    let fixture = Fixture::new()?;
    // Larger than age's 64 KiB chunk, so the file has more than one chunk.
    fixture.vault.put(item("large", &"x".repeat(200_000)))?;
    let good = std::fs::read(fixture.paths.file())?;
    let plaintext = age::decrypt(&fixture.identity()?, &good)?.len();
    let last_chunk = plaintext % 65_536 + 16;
    std::fs::write(fixture.paths.file(), &good[..good.len() - last_chunk])?;
    assert!(matches!(fixture.vault.read(), Err(VaultError::Refused)));

    let other = Fixture::new()?;
    std::fs::copy(other.paths.file(), fixture.paths.file())?;
    assert!(matches!(fixture.vault.read(), Err(VaultError::Refused)));
    Ok(())
}

// test-category: security
#[test]
fn unknown_format_refuses_and_a_public_key_can_forge() -> Outcome {
    butler_e2e::gate!();
    let fixture = Fixture::new()?;
    let recipient: age::x25519::Recipient = fixture.vault.device_recipient()?.parse()?;
    let write = |payload: Value| -> Outcome {
        let sealed = age::encrypt(&recipient, serde_json::to_vec(&payload)?.as_slice())?;
        std::fs::write(fixture.paths.file(), sealed)?;
        Ok(())
    };
    let valid = json!({
        "format": 1, "vault_id": "v", "seq": 9, "recipients": [recipient.to_string()],
        "items": [], "tombstones": [],
    });
    let mut newer = valid.clone();
    newer["format"] = json!(2);
    let mut unknown_field = valid.clone();
    unknown_field["added_later"] = json!(true);
    for bad in [newer, unknown_field] {
        write(bad)?;
        let before = std::fs::read(fixture.paths.file())?;
        assert!(matches!(fixture.vault.read(), Err(VaultError::Format)));
        assert!(matches!(
            fixture.vault.put(item("new", "x")),
            Err(VaultError::Format)
        ));
        assert_eq!(std::fs::read(fixture.paths.file())?, before);
    }
    // age has no sender authentication: this is why the public key stays
    // inside the payload.
    write(valid)?;
    assert_eq!(fixture.vault.read()?.seq, 9);
    Ok(())
}

// test-category: security
#[test]
fn a_save_that_would_lock_this_device_out_writes_nothing() -> Outcome {
    butler_e2e::gate!();
    let fixture = Fixture::new()?;
    fixture.vault.put(item("site", "1"))?;
    let device: age::x25519::Recipient = fixture.vault.device_recipient()?.parse()?;
    let attacker = age::x25519::Identity::generate().to_public().to_string();
    let forged = json!({
        "format": 1, "vault_id": "v", "seq": 9, "recipients": [attacker],
        "items": [], "tombstones": [],
    });
    let sealed = age::encrypt(&device, serde_json::to_vec(&forged)?.as_slice())?;
    std::fs::write(fixture.paths.file(), &sealed)?;
    let previous = std::fs::read(fixture.paths.previous())?;

    assert!(matches!(
        fixture.vault.put(item("new", "x")),
        Err(VaultError::Refused)
    ));
    assert_eq!(std::fs::read(fixture.paths.file())?, sealed);
    assert_eq!(std::fs::read(fixture.paths.previous())?, previous);
    assert_eq!(fixture.vault.read()?.seq, 9);
    Ok(())
}

// test-category: security
#[test]
fn a_huge_header_is_refused_without_parsing_it() -> Outcome {
    butler_e2e::gate!();
    let fixture = Fixture::new()?;
    let mut hostile = b"age-encryption.org/v1\n".to_vec();
    while hostile.len() < 1024 * 1024 {
        hostile.extend_from_slice(b"-> a\n\n");
    }
    let import = fixture.folder.path().join("hostile.age");
    std::fs::write(&import, &hostile)?;
    std::fs::write(fixture.paths.file(), &hostile)?;
    std::fs::write(fixture.paths.key_file(), &hostile)?;
    let answers = super::without_hanging(move || {
        let second = Vault::new(fixture.paths.clone());
        [
            fixture.vault.read().map(|_| ()),
            fixture.vault.put(item("new", "x")),
            fixture.vault.import(&import, &password()).map(|_| ()),
            second.unlock_with_password(&password()),
        ]
    });
    for answer in answers {
        assert!(matches!(answer, Err(VaultError::Refused)), "{answer:?}");
    }
    Ok(())
}

#[test]
fn a_vault_with_many_recipients_still_opens() -> Outcome {
    butler_e2e::gate!();
    let fixture = Fixture::new()?;
    let device = fixture.vault.device_recipient()?;
    let mut recipients = vec![device.parse::<age::x25519::Recipient>()?];
    recipients.extend((0..99).map(|_| age::x25519::Identity::generate().to_public()));
    let names: Vec<String> = recipients.iter().map(ToString::to_string).collect();
    let payload = json!({
        "format": 1, "vault_id": "v", "seq": 9, "recipients": names,
        "items": [], "tombstones": [],
    });
    let encryptor = age::Encryptor::with_recipients(
        recipients
            .iter()
            .map(|recipient| recipient as &dyn age::Recipient),
    )?;
    let mut sealed = Vec::new();
    let mut writer = encryptor.wrap_output(&mut sealed)?;
    writer.write_all(&serde_json::to_vec(&payload)?)?;
    writer.finish()?;
    std::fs::write(fixture.paths.file(), &sealed)?;
    assert_eq!(fixture.vault.read()?.recipients.len(), 100);
    Ok(())
}

#[test]
fn a_save_keeps_the_previous_file_and_restoring_is_explicit() -> Outcome {
    butler_e2e::gate!();
    let fixture = Fixture::new()?;
    fixture.vault.put(item("first", "1"))?;
    let after_first = std::fs::read(fixture.paths.file())?;
    fixture.vault.put(item("second", "2"))?;
    assert_eq!(std::fs::read(fixture.paths.previous())?, after_first);

    assert!(matches!(
        fixture.vault.restore_previous(),
        Err(VaultError::NotDamaged)
    ));

    let mut damaged = std::fs::read(fixture.paths.file())?;
    damaged[40] ^= 1;
    std::fs::write(fixture.paths.file(), &damaged)?;
    assert!(matches!(fixture.vault.read(), Err(VaultError::Refused)));
    fixture.vault.restore_previous()?;

    let restored = fixture.vault.read()?;
    assert!(restored.item("first").is_some());
    assert!(restored.item("second").is_none());
    let kept = files_under(fixture.folder.path())?;
    assert!(
        kept.iter()
            .any(|(path, bytes)| path.to_string_lossy().contains(".damaged-") && *bytes == damaged)
    );
    Ok(())
}

// test-category: security
#[test]
fn a_vault_with_only_its_previous_copy_is_damaged_not_absent() -> Outcome {
    butler_e2e::gate!();
    let fixture = Fixture::new()?;
    fixture.vault.put(item("site", "1"))?;
    std::fs::remove_file(fixture.paths.file())?;
    assert!(matches!(fixture.vault.read(), Err(VaultError::Refused)));
    assert!(matches!(
        fixture.vault.create_with_password(&secret(PASSWORD)),
        Err(VaultError::AlreadyExists)
    ));
    fixture.vault.restore_previous()?;
    assert!(fixture.vault.get("site")?.is_none());
    assert_eq!(fixture.vault.read()?.seq, 1);
    Ok(())
}

// test-category: security
#[test]
fn no_plaintext_reaches_disk() -> Outcome {
    butler_e2e::gate!();
    let fixture = Fixture::new()?;
    fixture
        .vault
        .put(item("canary-id", "canary-secret-value"))?;
    fixture
        .vault
        .put(item("canary-gone", "canary-secret-gone"))?;
    fixture.vault.delete("canary-gone")?;
    fixture
        .vault
        .set_password(&secret("another long password"))?;
    fixture
        .vault
        .export(&fixture.folder.path().join("export.age"), &secret(PASSWORD))?;
    let public_key = fixture.vault.device_recipient()?;
    for (path, bytes) in files_under(fixture.folder.path())? {
        for needle in [
            "canary",
            "updated_at",
            "tombstones",
            "AGE-SECRET-KEY",
            public_key.as_str(),
        ] {
            assert!(
                !contains(&bytes, needle.as_bytes()),
                "{needle} in {}",
                path.display()
            );
        }
        assert_eq!(
            secure_fs::is_private(&path),
            Some(true),
            "{}",
            path.display()
        );
    }
    let printed = format!("{:?}", fixture.vault.read()?);
    assert!(!printed.contains("canary-secret-value"));
    assert!(!printed.contains(public_key.as_str()));
    Ok(())
}

#[test]
fn reading_writes_nothing() -> Outcome {
    butler_e2e::gate!();
    let fixture = Fixture::new()?;
    fixture.vault.put(item("site", "1"))?;
    fixture.vault.put(item("other", "2"))?;
    let export = fixture.folder.path().join("export.age");
    fixture.vault.export(&export, &secret(PASSWORD))?;
    let snapshot = || -> Result<Vec<_>, std::io::Error> {
        files_under(fixture.folder.path())?
            .into_iter()
            .filter(|(path, _)| !path.ends_with("vault.age.lock"))
            .map(|(path, bytes)| {
                let modified = std::fs::metadata(&path)?.modified()?;
                Ok((path, bytes, modified))
            })
            .collect()
    };
    let before = snapshot()?;
    for _ in 0..50 {
        fixture.vault.read()?;
        fixture.vault.get("site")?;
        fixture.vault.state()?;
    }
    assert!(!fixture.vault.delete("no-such-item")?);
    assert!(!fixture.vault.import(&export, &secret(PASSWORD))?);
    fixture
        .vault
        .add_recipient(&fixture.vault.device_recipient()?)?;
    assert_eq!(snapshot()?, before);
    Ok(())
}

// test-category: race
#[test]
fn concurrent_saves_lose_nothing() -> Outcome {
    butler_e2e::gate!();
    let fixture = Fixture::new()?;
    let other = fixture.second_handle()?;
    std::thread::scope(|scope| {
        for (name, vault) in [("a", &fixture.vault), ("b", &other)] {
            scope.spawn(move || {
                for index in 0..25 {
                    vault.put(item(&format!("{name}-{index}"), "x")).unwrap();
                }
            });
        }
    });
    let payload = fixture.vault.read()?;
    assert_eq!(payload.items.len(), 50);
    assert_eq!(payload.seq, 51);
    Ok(())
}

// test-category: security
#[test]
fn a_killed_writer_leaves_an_openable_vault_with_every_acknowledged_save() -> Outcome {
    butler_e2e::gate!();
    let fixture = Fixture::new()?;
    let identity = fixture.identity()?;
    let auth = fixture.folder.path().join("auth");
    let mut acknowledged = 0_u64;
    // Keeps killing until the leftovers prove both writes of a save were cut
    // short: the copy to `.prev`, and the new `vault.age`.
    let mut rounds = 0_u32;
    while !both_writes_interrupted(fixture.folder.path())? || rounds < 8 {
        assert!(rounds < 300, "no kill landed inside a save");
        let mut writer = Writer(
            Command::new(fixture_binary("e2e-vault")?)
                .arg("write")
                .arg(&auth)
                .arg(PASSWORD)
                .arg(rounds.to_string())
                .stdout(Stdio::piped())
                .spawn()?,
        );
        let mut lines = BufReader::new(writer.0.stdout.take().unwrap()).lines();
        lines.next().unwrap()?;
        let started = Instant::now();
        let last = lines.next().unwrap()?;
        acknowledged += 2;
        // Each round dies at a different point of the next save.
        std::thread::sleep(started.elapsed() * (rounds % 8) / 8);
        drop(writer);

        let payload = fixture.vault.read()?;
        assert!(payload.item(&last).is_some(), "lost save {last}");
        assert!(payload.seq > acknowledged);
        age::decrypt(&identity, &std::fs::read(fixture.paths.previous())?)?;
        for (path, bytes) in files_under(fixture.folder.path())? {
            assert!(!contains(&bytes, b"e2e-vault-secret"), "{}", path.display());
        }
        rounds += 1;
    }
    eprintln!("vault crash scenario: {rounds} kills, {acknowledged} saves acknowledged");
    // The dead writers' locks are gone, and their leftovers are ignored.
    fixture.vault.put(item("after", "1"))?;
    assert!(fixture.vault.get("after")?.is_some());
    Ok(())
}

fn both_writes_interrupted(root: &Path) -> Result<bool, std::io::Error> {
    let names: Vec<String> = files_under(root)?
        .into_iter()
        .map(|(path, _)| path.file_name().unwrap().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".tmp"))
        .collect();
    let previous = |name: &String| name.starts_with(".vault.age.prev.");
    Ok(names.iter().any(previous)
        && names
            .iter()
            .any(|name| name.starts_with(".vault.age.") && !previous(name)))
}
