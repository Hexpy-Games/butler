//! HTTP hook signing secrets. They live in the credential stores that hold
//! provider keys, chosen by the same policy, and never in hooks.json, settings,
//! run records or error text.
use butler_core::hooks::{HookConfig, HookDefinition};
use butler_models::models::{
    CredentialStoreError, CredentialStores, SecretStoreFacts, credential_store_policy,
    fallback_file, scoped_secret_key,
};
use butler_platform::secrets::{SYSTEM_BACKEND, SecretBackend, SecretKey, SecretText};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
const SERVICE: &str = "com.hexpy.butler.hook-secret";
/// Safe for Settings: store errors never carry secret bytes, but this says less.
pub(super) const STORE_FAILED: &str = "Hook secret store unavailable";
pub(super) struct HookSecrets {
    root: PathBuf,
    /// Opened on the first HTTP hook; nothing happens without one.
    stores: tokio::sync::OnceCell<CredentialStores>,
}
fn key(root: &Path, backend: SecretBackend, id: &str) -> Result<SecretKey, String> {
    scoped_secret_key(root, backend, SERVICE, id).map_err(|_| STORE_FAILED.to_owned())
}
fn failed(_: CredentialStoreError) -> String {
    STORE_FAILED.to_owned()
}
fn is_http(hook: &HookDefinition) -> bool {
    hook.kind == "http"
}
impl HookSecrets {
    pub(super) fn new(root: PathBuf) -> Self {
        Self {
            root,
            stores: tokio::sync::OnceCell::new(),
        }
    }
    /// The stores, with the host facts read off the async workers.
    async fn stores(&self) -> Result<&CredentialStores, String> {
        self.stores
            .get_or_try_init(|| async {
                let root = self.root.clone();
                tokio::task::spawn_blocking(move || {
                    CredentialStores::new(SecretStoreFacts::for_data_root(&root))
                })
                .await
                .map_err(|_| STORE_FAILED.to_owned())
            })
            .await
    }
    /// The hook's secret. One left in the file by a build that used it moves to
    /// the system store once the policy selects that store.
    pub(super) async fn find(&self, id: &str) -> Result<Option<SecretText>, String> {
        let stores = self.stores().await?;
        let target = stores.target(&self.root).await.map_err(failed)?.store;
        let held = key(&self.root, target.backend(), id)?;
        if let Some(secret) = stores.get(&target, &held).await.map_err(failed)? {
            return Ok(Some(secret));
        }
        if !target.backend().is_system() {
            return Ok(None);
        }
        let file = fallback_file(&self.root);
        let old = key(&self.root, file.backend(), id)?;
        let Some(secret) = stores.get(&file, &old).await.map_err(failed)? else {
            return Ok(None);
        };
        stores
            .put(&target, &held, secret.expose())
            .await
            .map_err(failed)?;
        stores.remove(&file, &old).await.map_err(failed)?;
        Ok(Some(secret))
    }
    async fn put(&self, id: &str, secret: &str) -> Result<(), String> {
        let stores = self.stores().await?;
        let target = stores.target(&self.root).await.map_err(failed)?.store;
        let held = key(&self.root, target.backend(), id)?;
        stores.put(&target, &held, secret).await.map_err(failed)
    }
    /// Stores the given secrets and creates the missing ones, before the
    /// configuration naming them is saved. Returns the created ones.
    pub(super) async fn prepare(
        &self,
        config: &HookConfig,
        mut given: BTreeMap<String, SecretText>,
    ) -> Result<BTreeMap<String, String>, String> {
        let mut generated = BTreeMap::new();
        for hook in config.hooks.iter().filter(|hook| is_http(hook)) {
            if let Some(secret) = given.remove(&hook.id) {
                self.put(&hook.id, secret.expose()).await?;
            } else if self.find(&hook.id).await?.is_none() {
                let fresh = format!(
                    "{}{}",
                    uuid::Uuid::new_v4().simple(),
                    uuid::Uuid::new_v4().simple()
                );
                self.put(&hook.id, &fresh).await?;
                generated.insert(hook.id.clone(), fresh);
            }
        }
        Ok(generated)
    }
    /// Removes the secrets of hooks that are no longer HTTP hooks. The saved
    /// configuration stands either way; a leftover only waits for its id.
    pub(super) async fn forget(&self, previous: &HookConfig, current: &HookConfig) {
        let kept = |id: &str| {
            current
                .hooks
                .iter()
                .any(|hook| is_http(hook) && hook.id == id)
        };
        for hook in previous.hooks.iter().filter(|hook| is_http(hook)) {
            if !kept(&hook.id) && self.remove(&hook.id).await.is_err() {
                tracing::warn!(event = "hook_secret_left", hook_id = %hook.id);
            }
        }
    }
    async fn remove(&self, id: &str) -> Result<(), String> {
        let stores = self.stores().await?;
        let target = stores.target(&self.root).await.map_err(failed)?.store;
        let held = key(&self.root, target.backend(), id)?;
        stores.remove(&target, &held).await.map_err(failed)?;
        if target.backend().is_system() {
            let file = fallback_file(&self.root);
            let old = key(&self.root, file.backend(), id)?;
            stores.remove(&file, &old).await.map_err(failed)?;
        }
        Ok(())
    }
}
/// The system-store keys a full data reset must delete; the file store goes
/// with the data folder. Nothing when the policy keeps secrets in the file.
pub(crate) fn reset_keys(root: &Path) -> Vec<(String, String)> {
    let facts = SecretStoreFacts::for_data_root(root);
    if credential_store_policy(root, facts).store != "system" {
        return Vec::new();
    }
    let path = root.join(butler_platform::data_paths::HOOKS);
    let Some(config) = std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<HookConfig>(&bytes).ok())
    else {
        return Vec::new();
    };
    config
        .hooks
        .iter()
        .filter(|hook| is_http(hook))
        .filter_map(|hook| scoped_secret_key(root, SYSTEM_BACKEND, SERVICE, &hook.id).ok())
        .map(|key| (key.service().to_owned(), key.account().to_owned()))
        .collect()
}
