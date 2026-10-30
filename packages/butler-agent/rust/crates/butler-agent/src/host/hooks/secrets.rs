//! HTTP hook signing secrets. A secret lives in the credential stores that hold
//! provider keys, chosen by the same policy; it is never in hooks.json, settings,
//! run records or error text. Like the provider credentials file, an owner-only
//! index records what is not secret: which store holds each written id, and the
//! URL origin the secret was issued for. Entries are written before the secret,
//! so a full reset can always find it, and gain their origin only after the
//! configuration naming them is saved, so an interrupted save never signs and the
//! next save issues a new secret.
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
/// A stored key no entry tracks any more, because deleting it failed.
#[derive(Deserialize, Serialize)]
struct Leftover {
    id: String,
    storage: String,
}
#[derive(Default, Deserialize, Serialize)]
struct Index {
    hooks: BTreeMap<String, Entry>,
    #[serde(default)]
    leftovers: Vec<Leftover>,
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
    changes: Vec<Change>,
}
/// One id this save changes, and what it replaces.
struct Change {
    id: String,
    origin: String,
    storage: String,
    previous: Option<Entry>,
    old_secret: Option<SecretText>,
    /// Whether the store accepted the new secret.
    written: bool,
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
        let backend = backend(&entry.storage)?;
        let store = stores.holding(&self.root, backend).await.map_err(failed)?;
        let key = self.key(backend, id).await?;
        stores.get(&store, &key).await.map_err(failed)
    }
    async fn delete(&self, storage: &str, id: &str) -> Result<(), String> {
        let stores = self.stores().await?;
        let backend = backend(storage)?;
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
    /// The secret an id's previous entry holds. One that cannot be read in the
    /// store about to be overwritten refuses the save before anything changes.
    async fn old_secret(
        &self,
        previous: Option<&Entry>,
        storage: &str,
        id: &str,
    ) -> Result<Option<SecretText>, String> {
        let Some(entry) = previous else {
            return Ok(None);
        };
        match self.read(entry, id).await {
            Ok(secret) => Ok(secret),
            Err(error) if entry.storage == storage => Err(error),
            Err(_) => Ok(None),
        }
    }
    /// Stores `secret` for `id`, remembering what it replaces. It cannot sign
    /// until `activate` gives its entry an origin.
    async fn write(
        &self,
        id: &str,
        origin: &str,
        secret: &str,
        changes: &mut Vec<Change>,
    ) -> Result<(), String> {
        let stores = self.stores().await?;
        let target = stores.target(&self.root).await.map_err(failed)?.store;
        let storage = target.backend().as_str().to_owned();
        let mut index = self.index().await?;
        let previous = index.hooks.get(id).cloned();
        let old_secret = self.old_secret(previous.as_ref(), &storage, id).await?;
        changes.push(Change {
            id: id.to_owned(),
            origin: origin.to_owned(),
            storage: storage.clone(),
            previous,
            old_secret,
            written: false,
        });
        let pending = Entry {
            storage,
            origin: None,
        };
        index.hooks.insert(id.to_owned(), pending);
        self.save_index(&index).await?;
        let key = self.key(target.backend(), id).await?;
        stores.put(&target, &key, secret).await.map_err(failed)?;
        if let Some(change) = changes.last_mut() {
            change.written = true;
        }
        Ok(())
    }
    /// Whether a hook gets a new secret without being given one: after an
    /// interrupted write, or when this save adds it or changes its URL and no
    /// secret exists for its origin. Any other hook without one, such as a hand
    /// edit, keeps refusing to send until a save gives it a secret.
    async fn needs_secret(
        &self,
        hook: &HookDefinition,
        origin: &str,
        published: &HookConfig,
    ) -> Result<bool, String> {
        let index = self.index().await?;
        if index
            .hooks
            .get(&hook.id)
            .is_some_and(|entry| entry.origin.is_none())
        {
            return Ok(true);
        }
        let before = published.hooks.iter().find(|old| old.id == hook.id);
        if before.and_then(|old| old.url.as_deref()) == hook.url.as_deref() {
            return Ok(false);
        }
        Ok(!matches!(
            self.find(&hook.id, origin).await?,
            Lookup::Found(_)
        ))
    }
    /// Stores given secrets and issues the ones `needs_secret` selects, before
    /// the configuration naming them is saved. A store that cannot answer
    /// refuses the save rather than replacing a secret.
    pub(super) async fn prepare(
        &self,
        config: &HookConfig,
        published: &HookConfig,
        given: BTreeMap<String, SecretText>,
    ) -> Result<Prepared, String> {
        let mut prepared = Prepared {
            generated: BTreeMap::new(),
            changes: Vec::new(),
        };
        match self.apply(config, published, given, &mut prepared).await {
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
        published: &HookConfig,
        mut given: BTreeMap<String, SecretText>,
        prepared: &mut Prepared,
    ) -> Result<(), String> {
        for hook in config.hooks.iter().filter(|hook| is_http(hook)) {
            let origin = url_origin(hook.url.as_deref().unwrap_or_default());
            if let Some(secret) = given.remove(&hook.id) {
                self.write(&hook.id, &origin, secret.expose(), &mut prepared.changes)
                    .await?;
            } else if self.needs_secret(hook, &origin, published).await? {
                let fresh = format!(
                    "{}{}",
                    uuid::Uuid::new_v4().simple(),
                    uuid::Uuid::new_v4().simple()
                );
                self.write(&hook.id, &origin, &fresh, &mut prepared.changes)
                    .await?;
                prepared.generated.insert(hook.id.clone(), fresh);
            }
        }
        Ok(())
    }
    /// Lets the secrets of a saved configuration sign, and removes the ones they
    /// replaced from other stores.
    pub(super) async fn activate(&self, prepared: &Prepared) -> Result<(), String> {
        if prepared.changes.is_empty() {
            return Ok(());
        }
        let mut index = self.index().await?;
        for change in &prepared.changes {
            let entry = Entry {
                storage: change.storage.clone(),
                origin: Some(change.origin.clone()),
            };
            index.hooks.insert(change.id.clone(), entry);
            let moved = change
                .previous
                .as_ref()
                .filter(|old| old.storage != change.storage);
            if let Some(old) = moved
                && self.delete(&old.storage, &change.id).await.is_err()
            {
                tracing::warn!(event = "hook_secret_left", hook_id = %change.id);
                index.leftovers.push(Leftover {
                    id: change.id.clone(),
                    storage: old.storage.clone(),
                });
            }
        }
        self.save_index(&index).await
    }
    /// Withdraws the secrets of a completed save nobody received: they stop
    /// signing, and the next save issues new ones.
    pub(super) async fn withdraw(&self, ids: impl Iterator<Item = &String>) {
        let Ok(mut index) = self.index().await else {
            return;
        };
        for id in ids {
            if let Some(entry) = index.hooks.get_mut(id) {
                entry.origin = None;
            }
        }
        if self.save_index(&index).await.is_err() {
            tracing::warn!(event = "hook_secret_index_stale");
        }
    }
    /// Puts back what a save that did not complete changed.
    pub(super) async fn rollback(&self, prepared: Prepared) {
        for change in prepared.changes.into_iter().rev() {
            let id = change.id.clone();
            if self.restore(change).await.is_err() {
                tracing::warn!(event = "hook_secret_rollback_failed", hook_id = %id);
            }
        }
    }
    /// Undoes the store write, if the store accepted one.
    async fn unwrite(&self, change: &Change) -> Result<(), String> {
        if !change.written {
            return Ok(());
        }
        let same_place = change
            .previous
            .as_ref()
            .is_some_and(|old| old.storage == change.storage);
        match change.old_secret.as_ref().filter(|_| same_place) {
            Some(secret) => {
                let stores = self.stores().await?;
                let backend = backend(&change.storage)?;
                let store = stores.holding(&self.root, backend).await.map_err(failed)?;
                let key = self.key(backend, &change.id).await?;
                stores
                    .put(&store, &key, secret.expose())
                    .await
                    .map_err(failed)
            }
            None => self.delete(&change.storage, &change.id).await,
        }
    }
    /// The store comes first, so it is restored even when the index cannot be
    /// written. An entry whose write could not be undone stays without an origin:
    /// it never signs, and the next save issues a new secret.
    async fn restore(&self, change: Change) -> Result<(), String> {
        let undone = self.unwrite(&change).await;
        let mut index = self.index().await?;
        match (&undone, change.previous) {
            (Ok(()), Some(previous)) => {
                index.hooks.insert(change.id, previous);
            }
            (Ok(()), None) => {
                index.hooks.remove(&change.id);
            }
            (Err(_), Some(previous)) if previous.storage != change.storage => {
                index.leftovers.push(Leftover {
                    id: change.id,
                    storage: previous.storage,
                });
            }
            (Err(_), _) => {}
        }
        self.save_index(&index).await?;
        undone
    }
    /// Removes the secret of every written id that is no longer an HTTP hook,
    /// hand-removed ones included, and retries leftovers. The saved configuration
    /// stands either way; a failure stays in the index for the next save and for
    /// a reset.
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
        let stale: Vec<(String, String)> = index
            .hooks
            .iter()
            .filter(|(id, _)| !kept(id))
            .map(|(id, entry)| (id.clone(), entry.storage.clone()))
            .collect();
        if stale.is_empty() && index.leftovers.is_empty() {
            return;
        }
        for (id, storage) in stale {
            if self.delete(&storage, &id).await.is_ok() {
                index.hooks.remove(&id);
            } else {
                tracing::warn!(event = "hook_secret_left", hook_id = %id);
            }
        }
        let mut remaining = Vec::new();
        for left in std::mem::take(&mut index.leftovers) {
            // A later write to the same store made this key live again.
            let live = index
                .hooks
                .get(&left.id)
                .is_some_and(|entry| entry.storage == left.storage);
            if !live && self.delete(&left.storage, &left.id).await.is_err() {
                remaining.push(left);
            }
        }
        index.leftovers = remaining;
        if self.save_index(&index).await.is_err() {
            tracing::warn!(event = "hook_secret_index_stale");
        }
    }
}
/// The system-store keys a full data reset must delete: every written id and
/// leftover, whatever hooks.json says now. The file store goes with the data folder.
pub(crate) fn reset_keys(root: &Path) -> Vec<(String, String)> {
    let Ok(index) = read_index(root) else {
        tracing::warn!(event = "hook_secret_index_unreadable");
        return Vec::new();
    };
    let tracked = index.hooks.iter().map(|(id, entry)| (id, &entry.storage));
    let leftovers = index.leftovers.iter().map(|left| (&left.id, &left.storage));
    tracked
        .chain(leftovers)
        .filter_map(|(id, storage)| Some((id, backend(storage).ok()?)))
        .filter(|(_, backend)| backend.is_system())
        .filter_map(|(id, backend)| scoped_secret_key(root, backend, SERVICE, id).ok())
        .map(|key| (key.service().to_owned(), key.account().to_owned()))
        .collect()
}
