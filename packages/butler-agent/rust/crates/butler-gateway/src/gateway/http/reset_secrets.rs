//! Read only the browser vaults' primary-key indexes, sharing their service rule.
use super::signin_secrets::{
    self, AUTOFILL_SERVICE, LEGACY_TRAVELER_SERVICE, PAYMENT_SERVICE, SERVICE,
};
use std::{io, path::Path};
pub fn reset_browser_secret_keys(
    root: &Path,
    db: &rusqlite::Connection,
) -> io::Result<Vec<(String, String)>> {
    let mut keys = Vec::new();
    for (table, service) in [
        ("browser_signin_entries", SERVICE),
        ("browser_payment_cards", PAYMENT_SERVICE),
        ("browser_autofill_profiles", AUTOFILL_SERVICE),
        ("browser_autofill_profiles", LEGACY_TRAVELER_SERVICE),
    ] {
        let mut statement = db
            .prepare(&format!("SELECT id FROM {table}"))
            .map_err(io::Error::other)?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(io::Error::other)?;
        let service = signin_secrets::service_in(root, service);
        for id in ids {
            keys.push((service.clone(), id.map_err(io::Error::other)?));
        }
    }
    Ok(keys)
}

/// Legacy browser secrets copied when this data folder switches to the vault.
pub fn vault_legacy_items(
    root: &Path,
    db: &rusqlite::Connection,
) -> io::Result<Vec<butler_vault::vault::LegacyItem>> {
    use butler_platform::secrets::SecretKey;
    use butler_vault::vault::{ItemKind, LegacyItem, LegacySource};
    let mut items = Vec::new();
    for (table, prefix, kind, services) in [
        (
            "browser_signin_entries",
            "signin",
            ItemKind::Signin,
            vec![SERVICE],
        ),
        (
            "browser_payment_cards",
            "card",
            ItemKind::Card,
            vec![PAYMENT_SERVICE],
        ),
        (
            "browser_autofill_profiles",
            "profile",
            ItemKind::Profile,
            vec![AUTOFILL_SERVICE, LEGACY_TRAVELER_SERVICE],
        ),
    ] {
        let mut statement = db
            .prepare(&format!("SELECT id FROM {table}"))
            .map_err(io::Error::other)?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(io::Error::other)?;
        for id in ids {
            let id = id.map_err(io::Error::other)?;
            let sources = services
                .iter()
                .map(|service| {
                    SecretKey::new(&signin_secrets::service_in(root, service), &id)
                        .map(LegacySource::System)
                        .map_err(io::Error::other)
                })
                .collect::<io::Result<Vec<_>>>()?;
            items.push(LegacyItem {
                id: format!("{prefix}/{id}"),
                kind,
                sources,
            });
        }
    }
    let mut statement = db
        .prepare("SELECT run_id, entry_id FROM browser_import_updates")
        .map_err(io::Error::other)?;
    let backups = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(io::Error::other)?;
    for backup in backups {
        let (run, id) = backup.map_err(io::Error::other)?;
        let entry = super::browser_import::password_undo::backup(&run, &id);
        let key = SecretKey::new(&signin_secrets::service_in(root, SERVICE), &entry)
            .map_err(io::Error::other)?;
        items.push(LegacyItem {
            id: format!("signin/{entry}"),
            kind: ItemKind::ImportBackup,
            sources: vec![LegacySource::System(key)],
        });
    }
    Ok(items)
}
