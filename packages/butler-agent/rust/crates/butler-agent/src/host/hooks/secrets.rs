//! HTTP hook signing secrets. A secret lives in the credential stores that hold
//! provider keys, chosen by the same policy; it is never in hooks.json, settings,
//! run records or error text. Like the provider credentials file, an owner-only
//! index records what is not secret: which store holds each written id, and the
//! URL origin the secret was issued for. Entries are written before the secret,
//! so a full reset can always find it, and without an origin until it is stored,
//! so an interrupted write never signs.
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
#[derive(Clone, Deserialize, Serialize)]
struct Entry {
    /// The public name of the backend holding the secret.
    storage: String,
    /// The origin the secret was issued for; absent until it is stored.
    origin: Option<String>,
}
#[derive(Default, Deserialize, Serialize)]
struct Index {
    hooks: BTreeMap<String, Entry>,
}
/// What a hook may sign with for one origin.
pub(super) enum Lookup {
    Found(SecretText),
    Missing,
    OtherOrigin,
}
/// Secrets stored for a configuration not yet saved.
pub(super) struct Prepared {
    pub(super) generated: BTreeMap<String, String>,
    undo: Vec<Undo>,
}
/// One id's state before this save changed it.
struct Undo {
    id: String,
    entry: Option<Entry>,
    secret: Option<SecretText>,
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
fn backend(entry: &Entry) -> Result<SecretBackend, String> {
    SecretBackend::from_name(&entry.storage).ok_or_else(|| STORE_FAILED.to_owned())
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
/// A URL's origin as the sending parser sees it; empty when it cannot parse,
/// and such a URL is refused before sending.
pub(super) fn url_origin(url: &str) -> String {
    reqwest::Url::parse(url)
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_default()
}
/// Runs filesystem work off the async workers.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| STORE_FAILED.to_owned())?
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
        blocking(move || read_index(&root).map_err(|_| STORE_FAILED.to_owned())).await
    }
    async fn save_index(&self, index: &Index) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(index).map_err(|_| STORE_FAILED.to_owned())?;
        let path = self.root.join(INDEX);
        blocking(move || {
            if let Some(parent) = path.parent() {
                secure_fs::create_private_dir_all(parent).map_err(|_| STORE_FAILED.to_owned())?;
            }
            secure_fs::replace_private(
                &path,
                |file| file.write_all(&bytes).map_err(|_| STORE_FAILED.to_owned()),
                |_| STORE_FAILED.to_owned(),
            )
        })
        .await
    }
    /// A store key; the system store's names the canonical data folder.
    async fn key(&self, backend: SecretBackend, id: &str) -> Result<SecretKey, String> {
        let (root, id) = (self.root.clone(), id.to_owned());
        blocking(move || {
            scoped_secret_key(&root, backend, SERVICE, &id).map_err(|_| STORE_FAILED.to_owned())
        })
        .await
    }
    async fn read(&self, entry: &Entry, id: &str) -> Result<Option<SecretText>, String> {
        let stores = self.stores().await?;
        let backend = backend(entry)?;
        let store = stores.holding(&self.root, backend).await.map_err(failed)?;
        let key = self.key(backend, id).await?;
        stores.get(&store, &key).await.map_err(failed)
    }
    async fn delete(&self, entry: &Entry, id: &str) -> Result<(), String> {
        let stores = self.stores().await?;
        let backend = backend(entry)?;
        let store = stores.holding(&self.root, backend).await.map_err(failed)?;
        let key = self.key(backend, id).await?;
        stores.remove(&store, &key).await.map_err(failed)?;
        Ok(())
    }
    /// The secret a hook signs with for `origin`, from the store the index
    /// names. Only a secret issued for this origin ever signs.
    pub(super) async fn find(&self, id: &str, origin: &str) -> Result<Lookup, String> {
        let index = self.index().await?;
        let Some(entry) = index.hooks.get(id) else {
            return Ok(Lookup::Missing);
        };
        match entry.origin.as_deref() {
            None => return Ok(Lookup::Missing),
            Some(issued) if issued != origin => return Ok(Lookup::OtherOrigin),
            Some(_) => {}
        }
        Ok(self
            .read(entry, id)
            .await?
            .map_or(Lookup::Missing, Lookup::Found))
    }
    /// Stores `secret` for `id` and `origin`, remembering what it replaces.
    async fn write(
        &self,
        id: &str,
        origin: &str,
        secret: &str,
        undo: &mut Vec<Undo>,
    ) -> Result<(), String> {
        let stores = self.stores().await?;
        let target = stores.target(&self.root).await.map_err(failed)?.store;
        let storage = target.backend().as_str().to_owned();
        let mut index = self.index().await?;
        let previous = index.hooks.get(id).cloned();
        // An old store that cannot answer must not block setting a new secret.
        let old_secret = match &previous {
            Some(entry) => self.read(entry, id).await.ok().flatten(),
            None => None,
        };
        undo.push(Undo {
            id: id.to_owned(),
            entry: previous.clone(),
            secret: old_secret,
        });
        let pending = Entry {
            storage: storage.clone(),
            origin: None,
        };
        index.hooks.insert(id.to_owned(), pending);
        self.save_index(&index).await?;
        let key = self.key(target.backend(), id).await?;
        stores.put(&target, &key, secret).await.map_err(failed)?;
        if let Some(old) = previous.filter(|old| old.storage != storage)
            && self.delete(&old, id).await.is_err()
        {
            tracing::warn!(event = "hook_secret_left", hook_id = %id);
        }
        let stored = Entry {
            storage,
            origin: Some(origin.to_owned()),
        };
        index.hooks.insert(id.to_owned(), stored);
        self.save_index(&index).await
    }
    /// Stores given secrets and issues one for every HTTP hook without a secret
    /// for its origin, before the configuration naming them is saved. A store
    /// that cannot answer refuses the save rather than replacing a secret.
    pub(super) async fn prepare(
        &self,
        config: &HookConfig,
        given: BTreeMap<String, SecretText>,
    ) -> Result<Prepared, String> {
        let mut prepared = Prepared {
            generated: BTreeMap::new(),
            undo: Vec::new(),
        };
        match self.apply(config, given, &mut prepared).await {
            Ok(()) => Ok(prepared),
            Err(error) => {
                self.rollback(prepared).await;
                Err(error)
            }
        }
    }
    async fn apply(
        &self,
        config: &HookConfig,
        mut given: BTreeMap<String, SecretText>,
        prepared: &mut Prepared,
    ) -> Result<(), String> {
        for hook in config.hooks.iter().filter(|hook| is_http(hook)) {
            let origin = url_origin(hook.url.as_deref().unwrap_or_default());
            if let Some(secret) = given.remove(&hook.id) {
                self.write(&hook.id, &origin, secret.expose(), &mut prepared.undo)
                    .await?;
            } else if !matches!(self.find(&hook.id, &origin).await?, Lookup::Found(_)) {
                let fresh = format!(
                    "{}{}",
                    uuid::Uuid::new_v4().simple(),
                    uuid::Uuid::new_v4().simple()
                );
                self.write(&hook.id, &origin, &fresh, &mut prepared.undo)
                    .await?;
                prepared.generated.insert(hook.id.clone(), fresh);
            }
        }
        Ok(())
    }
    /// Puts back what a save that did not complete changed.
    pub(super) async fn rollback(&self, prepared: Prepared) {
        for undo in prepared.undo.into_iter().rev() {
            let id = undo.id.clone();
            if self.restore(undo).await.is_err() {
                tracing::warn!(event = "hook_secret_rollback_failed", hook_id = %id);
            }
        }
    }
    async fn restore(&self, undo: Undo) -> Result<(), String> {
        let mut index = self.index().await?;
        // Unsigned until restored, so a failure below issues a new secret next save.
        let current = index.hooks.get_mut(&undo.id).map(|entry| {
            entry.origin = None;
            entry.clone()
        });
        self.save_index(&index).await?;
        if let (Some(entry), Some(secret)) = (&undo.entry, &undo.secret) {
            let stores = self.stores().await?;
            let backend = backend(entry)?;
            let store = stores.holding(&self.root, backend).await.map_err(failed)?;
            let key = self.key(backend, &undo.id).await?;
            stores
                .put(&store, &key, secret.expose())
                .await
                .map_err(failed)?;
        }
        let same_place = |entry: &Entry| {
            undo.secret.is_some()
                && undo
                    .entry
                    .as_ref()
                    .is_some_and(|old| old.storage == entry.storage)
        };
        if let Some(entry) = current.as_ref().filter(|entry| !same_place(entry)) {
            self.delete(entry, &undo.id).await?;
        }
        match undo.entry.filter(|_| undo.secret.is_some()) {
            Some(entry) => index.hooks.insert(undo.id, entry),
            None => index.hooks.remove(&undo.id),
        };
        self.save_index(&index).await
    }
    /// Removes the secret of every written id that is no longer an HTTP hook,
    /// hand-removed ones included. The saved configuration stands either way;
    /// a failure stays in the index for the next save and for a reset.
    pub(super) async fn forget(&self, current: &HookConfig) {
        let Ok(mut index) = self.index().await else {
            return;
        };
        let kept = |id: &str| {
            current
                .hooks
                .iter()
                .any(|hook| is_http(hook) && hook.id == id)
        };
        let stale: Vec<(String, Entry)> = index
            .hooks
            .iter()
            .filter(|(id, _)| !kept(id))
            .map(|(id, entry)| (id.clone(), entry.clone()))
            .collect();
        if stale.is_empty() {
            return;
        }
        for (id, entry) in stale {
            if self.delete(&entry, &id).await.is_ok() {
                index.hooks.remove(&id);
            } else {
                tracing::warn!(event = "hook_secret_left", hook_id = %id);
            }
        }
        if self.save_index(&index).await.is_err() {
            tracing::warn!(event = "hook_secret_index_stale");
        }
    }
}
/// The system-store keys a full data reset must delete: every written id,
/// whatever hooks.json says now. The file store goes with the data folder.
pub(crate) fn reset_keys(root: &Path) -> Vec<(String, String)> {
    let Ok(index) = read_index(root) else {
        tracing::warn!(event = "hook_secret_index_unreadable");
        return Vec::new();
    };
    index
        .hooks
        .iter()
        .filter_map(|(id, entry)| Some((id, backend(entry).ok()?)))
        .filter(|(_, backend)| backend.is_system())
        .filter_map(|(id, backend)| scoped_secret_key(root, backend, SERVICE, id).ok())
        .map(|key| (key.service().to_owned(), key.account().to_owned()))
        .collect()
}
