//! HTTP hook signing secrets. A secret lives in the credential stores that hold
//! provider keys, chosen by the same policy; it is never in hooks.json, settings,
//! run records or error text. A key is never overwritten: each secret gets a new
//! store account, and an owner-only index says which one signs. Every key is in
//! `orphans` from before it is written until one atomic index write promotes it,
//! so a failed or interrupted save leaves the working entry and key untouched and
//! nothing needs undoing.
use butler_core::hooks::{HookConfig, HookDefinition};
use butler_models::models::{
    CredentialStoreError, CredentialStores, SecretStoreFacts, scoped_secret_key,
};
use butler_platform::{
    secrets::{SecretBackend, SecretKey, SecretText},
    secure_fs,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::{self, Read, Write},
    path::{Path, PathBuf},
};
const SERVICE: &str = "com.hexpy.butler.hook-secret";
const INDEX: &str = "auth/hook-secrets.json";
/// Safe for Settings: store errors never carry secret bytes, but this says less.
pub(super) const STORE_FAILED: &str = "Hook secret store unavailable";
/// A hook that can sign: its key, and the URL origin it was issued for.
#[derive(Clone, Deserialize, Serialize)]
struct Entry {
    /// The public name of the backend holding the key.
    storage: String,
    key: String,
    origin: String,
}
/// A key to delete. An origin marks a secret issued but never delivered, which
/// the next save for that id and origin replaces; a replaced key has none.
#[derive(Clone, Deserialize, Serialize)]
struct Orphan {
    id: String,
    storage: String,
    key: String,
    origin: Option<String>,
}
#[derive(Default, Deserialize, Serialize)]
struct Index {
    hooks: BTreeMap<String, Entry>,
    orphans: Vec<Orphan>,
}
impl Index {
    /// Moves a hook's entry to `orphans`, in the write that stops it signing.
    fn retire(&mut self, id: &str, entry: Entry) {
        self.orphans.push(Orphan {
            id: id.to_owned(),
            storage: entry.storage,
            key: entry.key,
            origin: None,
        });
    }
}
/// What a hook may sign with for one origin.
pub(super) enum Lookup {
    Found(SecretText),
    Missing,
    OtherOrigin,
}
/// Keys stored for a configuration not yet saved.
pub(super) struct Staged {
    pub(super) generated: BTreeMap<String, String>,
    keys: Vec<Orphan>,
}
pub(super) struct HookSecrets {
    root: PathBuf,
    /// Opened on the first HTTP hook; nothing happens without one.
    stores: tokio::sync::OnceCell<CredentialStores>,
}
fn failed(_: CredentialStoreError) -> String {
    STORE_FAILED.to_owned()
}
fn is_http(hook: &HookDefinition) -> bool {
    hook.kind == "http"
}
fn backend(storage: &str) -> Result<SecretBackend, String> {
    SecretBackend::from_name(storage).ok_or_else(|| STORE_FAILED.to_owned())
}
fn read_index(root: &Path) -> io::Result<Index> {
    match secure_fs::open_read_no_follow(&root.join(INDEX)) {
        Ok(mut file) => {
            let mut text = String::new();
            file.read_to_string(&mut text)?;
            serde_json::from_str(&text).map_err(io::Error::other)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Index::default()),
        Err(error) => Err(error),
    }
}
fn write_index(root: &Path, bytes: &[u8]) -> io::Result<()> {
    let path = root.join(INDEX);
    if let Some(parent) = path.parent() {
        secure_fs::create_private_dir_all(parent)?;
    }
    secure_fs::replace_private(&path, |file| file.write_all(bytes), |error| error)
}
/// A URL's origin as the sending parser sees it; empty when it cannot parse,
/// and such a URL is refused before sending.
pub(super) fn url_origin(url: &str) -> String {
    reqwest::Url::parse(url)
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_default()
}
/// Whether a save issues a secret for a hook it was not given one for. Never
/// when one exists for its origin. Otherwise, when this save adds the hook or
/// changes its URL, or a secret for this id and origin was never delivered; a
/// hand edit to any other origin keeps refusing to send.
fn needs_secret(
    index: &Index,
    hook: &HookDefinition,
    origin: &str,
    published: &HookConfig,
) -> bool {
    if index
        .hooks
        .get(&hook.id)
        .is_some_and(|entry| entry.origin == origin)
    {
        return false;
    }
    let before = published.hooks.iter().find(|old| old.id == hook.id);
    before.and_then(|old| old.url.as_deref()) != hook.url.as_deref()
        || index
            .orphans
            .iter()
            .any(|orphan| orphan.id == hook.id && orphan.origin.as_deref() == Some(origin))
}
/// Runs filesystem work off the async workers.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> io::Result<T> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| STORE_FAILED.to_owned())?
        .map_err(|_| STORE_FAILED.to_owned())
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
                blocking(move || {
                    Ok(CredentialStores::new(SecretStoreFacts::for_data_root(
                        &root,
                    )))
                })
                .await
            })
            .await
    }
    async fn index(&self) -> Result<Index, String> {
        let root = self.root.clone();
        blocking(move || read_index(&root)).await
    }
    async fn save_index(&self, index: &Index) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(index).map_err(|_| STORE_FAILED.to_owned())?;
        let root = self.root.clone();
        blocking(move || write_index(&root, &bytes)).await
    }
    /// A store key; the system store's names the canonical data folder.
    async fn key(&self, backend: SecretBackend, account: &str) -> Result<SecretKey, String> {
        let (root, account) = (self.root.clone(), account.to_owned());
        blocking(move || {
            scoped_secret_key(&root, backend, SERVICE, &account).map_err(io::Error::other)
        })
        .await
    }
    async fn delete(&self, storage: &str, account: &str) -> Result<(), String> {
        let stores = self.stores().await?;
        let backend = backend(storage)?;
        let store = stores.holding(&self.root, backend).await.map_err(failed)?;
        let key = self.key(backend, account).await?;
        stores.remove(&store, &key).await.map_err(failed)?;
        Ok(())
    }
    /// The secret a hook signs with for `origin`. Only a secret issued for this
    /// origin ever signs.
    pub(super) async fn find(&self, id: &str, origin: &str) -> Result<Lookup, String> {
        let index = self.index().await?;
        let Some(entry) = index.hooks.get(id) else {
            return Ok(Lookup::Missing);
        };
        if entry.origin != origin {
            return Ok(Lookup::OtherOrigin);
        }
        let stores = self.stores().await?;
        let backend = backend(&entry.storage)?;
        let store = stores.holding(&self.root, backend).await.map_err(failed)?;
        let key = self.key(backend, &entry.key).await?;
        let secret = stores.get(&store, &key).await.map_err(failed)?;
        Ok(secret.map_or(Lookup::Missing, Lookup::Found))
    }
    /// Stores the given secrets and the ones `needs_secret` selects under new
    /// keys, each listed in `orphans` before it is written, and before a full
    /// reset can have listed the keys or not at all. Nothing signs with them yet.
    pub(super) async fn stage(
        &self,
        config: &HookConfig,
        published: &HookConfig,
        mut given: BTreeMap<String, SecretText>,
    ) -> Result<Staged, String> {
        let mut index = self.index().await?;
        let mut generated = BTreeMap::new();
        let mut secrets = Vec::new();
        for hook in config.hooks.iter().filter(|hook| is_http(hook)) {
            let origin = url_origin(hook.url.as_deref().unwrap_or_default());
            if let Some(secret) = given.remove(&hook.id) {
                secrets.push((hook.id.clone(), origin, secret));
            } else if needs_secret(&index, hook, &origin, published) {
                let fresh = format!(
                    "{}{}",
                    uuid::Uuid::new_v4().simple(),
                    uuid::Uuid::new_v4().simple()
                );
                let secret = SecretText::new(fresh.clone());
                generated.insert(hook.id.clone(), fresh);
                secrets.push((hook.id.clone(), origin, secret));
            }
        }
        if secrets.is_empty() {
            return Ok(Staged {
                generated,
                keys: Vec::new(),
            });
        }
        let stores = self.stores().await?;
        let target = stores.target(&self.root).await.map_err(failed)?.store;
        let storage = target.backend().as_str();
        let mut keys = Vec::new();
        for (id, origin, _) in &secrets {
            keys.push(Orphan {
                id: id.clone(),
                storage: storage.to_owned(),
                key: format!("{id}.{}", uuid::Uuid::new_v4().simple()),
                origin: Some(origin.clone()),
            });
        }
        index.orphans.extend(keys.iter().cloned());
        let bytes = serde_json::to_vec_pretty(&index).map_err(|_| STORE_FAILED.to_owned())?;
        let root = self.root.clone();
        blocking(move || {
            crate::host::service::data_reset::unless_resetting(&root, || write_index(&root, &bytes))
        })
        .await?;
        for ((_, _, secret), orphan) in secrets.iter().zip(&keys) {
            let key = self.key(target.backend(), &orphan.key).await?;
            stores
                .put(&target, &key, secret.expose())
                .await
                .map_err(failed)?;
        }
        Ok(Staged { generated, keys })
    }
    /// Lets a saved configuration's new keys sign, in one write that also records
    /// every key they replace and those of hooks that are no longer HTTP hooks.
    pub(super) async fn promote(&self, staged: &Staged, config: &HookConfig) -> Result<(), String> {
        let mut index = self.index().await?;
        let kept = |id: &str| {
            config
                .hooks
                .iter()
                .any(|hook| is_http(hook) && hook.id == id)
        };
        let stale: Vec<String> = index.hooks.keys().filter(|id| !kept(id)).cloned().collect();
        if staged.keys.is_empty() && stale.is_empty() {
            return Ok(());
        }
        for new in &staged.keys {
            index.orphans.retain(|orphan| orphan.key != new.key);
            let entry = Entry {
                storage: new.storage.clone(),
                key: new.key.clone(),
                origin: new.origin.clone().unwrap_or_default(),
            };
            if let Some(old) = index.hooks.insert(new.id.clone(), entry) {
                index.retire(&new.id, old);
            }
        }
        for id in stale {
            if let Some(old) = index.hooks.remove(&id) {
                index.retire(&id, old);
            }
        }
        self.save_index(&index).await
    }
    /// Deletes every orphan; one that fails stays for the next save and a reset.
    pub(super) async fn sweep(&self) {
        let Ok(mut index) = self.index().await else {
            return;
        };
        if index.orphans.is_empty() {
            return;
        }
        let mut left = Vec::new();
        for orphan in std::mem::take(&mut index.orphans) {
            if self.delete(&orphan.storage, &orphan.key).await.is_err() {
                tracing::warn!(event = "hook_secret_left", hook_id = %orphan.id);
                left.push(orphan);
            }
        }
        index.orphans = left;
        if self.save_index(&index).await.is_err() {
            tracing::warn!(event = "hook_secret_index_stale");
        }
    }
}
/// The system-store keys a full data reset must delete: every key in the index,
/// whatever hooks.json says now. The file store goes with the data folder.
pub(crate) fn reset_keys(root: &Path) -> Vec<(String, String)> {
    let Ok(index) = read_index(root) else {
        tracing::warn!(event = "hook_secret_index_unreadable");
        return Vec::new();
    };
    let live = index
        .hooks
        .values()
        .map(|entry| (&entry.storage, &entry.key));
    let orphans = index
        .orphans
        .iter()
        .map(|orphan| (&orphan.storage, &orphan.key));
    live.chain(orphans)
        .filter_map(|(storage, account)| Some((backend(storage).ok()?, account)))
        .filter(|(backend, _)| backend.is_system())
        .filter_map(|(backend, account)| scoped_secret_key(root, backend, SERVICE, account).ok())
        .map(|key| (key.service().to_owned(), key.account().to_owned()))
        .collect()
}
