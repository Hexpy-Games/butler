use super::*;
use butler_platform::secrets::{SecretKey, SecretStore};
pub(super) fn store() -> Result<SecretStore> {
    SecretStore::system().map_err(|_| error("connector_secret_store_unavailable"))
}
pub(super) fn key(plugin: &str, connector: &str, account: &str, field: &str) -> Result<SecretKey> {
    SecretKey::new(
        "io.github.hexpy-games.butler.plugins",
        &format!("{plugin}/{connector}/{account}/{field}"),
    )
    .map_err(|_| error("connector_secret_key_invalid"))
}
impl Connectors {
    // Capture names before removing account or plugin metadata. No credential I/O.
    pub(in crate::host::plugins) fn secret_keys(
        &self,
        account: &Account,
    ) -> Result<Vec<SecretKey>> {
        self.definition(&account.plugin, &account.connector)?
            .account
            .secrets
            .iter()
            .map(|field| key(&account.plugin, &account.connector, &account.id, &field.key))
            .collect()
    }
}
