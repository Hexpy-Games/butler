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
    // Called only on the admin blocking lane, before forgetting account metadata.
    pub(in crate::host::plugins) fn delete_secrets(&self, account: &Account) -> Result<()> {
        let definition = self.definition(&account.plugin, &account.connector)?;
        if definition.account.secrets.is_empty() {
            return Ok(());
        }
        let store = store()?;
        for field in &definition.account.secrets {
            store
                .delete(&key(
                    &account.plugin,
                    &account.connector,
                    &account.id,
                    &field.key,
                )?)
                .map_err(|_| error("connector_secret_store_unavailable"))?;
        }
        Ok(())
    }
}
