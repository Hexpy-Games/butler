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
