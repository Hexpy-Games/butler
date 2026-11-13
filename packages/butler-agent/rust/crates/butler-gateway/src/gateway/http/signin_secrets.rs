//! Sign-in passwords, cards and profiles: in Butler Vault once this data
//! folder switched to it, else in the OS credential store. Without the vault
//! the module is off when the store policy picks the owner-only file or the
//! system store is missing.
//! Secrets are `SecretText` (wiped on drop) and never enter logs or results.
use super::browser_import::password_undo::BACKUP_PREFIX;
use super::{HttpError, HttpState};
use butler_platform::secrets::{SecretKey, SecretStore, SecretText};
use butler_vault::vault::{ItemKind, ProductVault, shared};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

/// The product service; another data folder gets its own suffixed service so
/// test and secondary folders never read or delete the owner's items.
pub(super) const SERVICE: &str = "com.hexpy.butler.signin";
const STORE_TIMEOUT: Duration = Duration::from_secs(20);

pub(super) struct SignInSecrets {
    store: tokio::sync::Mutex<Option<SecretStore>>,
    pub(super) mutation: tokio::sync::Mutex<()>,
    calls: tokio::sync::Semaphore,
    migrated: Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
}

impl SignInSecrets {
    pub(super) fn new() -> Self {
        Self {
            store: tokio::sync::Mutex::new(None),
            mutation: tokio::sync::Mutex::new(()),
            calls: tokio::sync::Semaphore::new(1),
            migrated: Arc::default(),
        }
    }
}

fn unavailable() -> HttpError {
    HttpError::public(
        409,
        "signin_unavailable",
        "Sign-ins need the system password store.",
    )
}

/// The payment vault's service (card numbers, CVCs, optional card PIN digits).
pub(super) const PAYMENT_SERVICE: &str = "com.hexpy.butler.payment";
/// Autofill profiles' service (birth date, passport and resident numbers).
pub(super) const AUTOFILL_SERVICE: &str = "com.hexpy.butler.autofill";
/// The autofill vault's service before the traveler migration.
pub(super) const LEGACY_TRAVELER_SERVICE: &str = "com.hexpy.butler.traveler";

#[allow(
    clippy::disallowed_methods,
    reason = "saved keychain services hash this spelling; another form would orphan them"
)]
pub(super) fn service_in(root: &Path, base: &str) -> String {
    use sha2::{Digest, Sha256};
    let default = butler_platform::user_dirs::home_dir().map(|home| home.join(".butler"));
    let resolve = |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if default
        .as_deref()
        .is_some_and(|home| resolve(home) == resolve(root))
    {
        return base.to_owned();
    }
    let digest = Sha256::digest(resolve(root).to_string_lossy().as_bytes());
    let hex = format!("{digest:x}");
    format!("{base}.{}", hex.get(..12).unwrap_or(&hex))
}

fn root(state: &HttpState) -> Option<PathBuf> {
    state.output_data.clone()
}

/// Whether passwords can be kept: the policy picks the system store and it answers.
pub(super) async fn available(state: &Arc<HttpState>) -> bool {
    match vault(state).await {
        Ok(Some(_)) => true,
        Err(_) => false,
        Ok(None) => store(state).await.is_ok(),
    }
}

async fn store(state: &Arc<HttpState>) -> Result<SecretStore, HttpError> {
    let root = root(state).ok_or_else(unavailable)?;
    let facts = butler_models::models::SecretStoreFacts::for_data_root(&root);
    if butler_models::models::credential_store_policy(&root, facts).store != "system" {
        return Err(unavailable());
    }
    let mut cached = state.signin_secrets.store.lock().await;
    if let Some(store) = cached.as_ref() {
        return Ok(store.clone());
    }
    let opened = blocking(state, SecretStore::system).await?;
    *cached = Some(opened.clone());
    Ok(opened)
}

async fn blocking<T: Send + 'static, E: Send + 'static>(
    state: &Arc<HttpState>,
    work: impl FnOnce() -> Result<T, E> + Send + 'static,
) -> Result<T, HttpError> {
    let _permit = state
        .signin_secrets
        .calls
        .acquire()
        .await
        .map_err(|_| unavailable())?;
    match tokio::time::timeout(STORE_TIMEOUT, tokio::task::spawn_blocking(work)).await {
        Ok(Ok(Ok(value))) => Ok(value),
        Ok(Ok(Err(_)) | Err(_)) => Err(HttpError::public(
            503,
            "signin_store_failed",
            "The keychain did not answer.",
        )),
        Err(_) => Err(HttpError::public(
            503,
            "signin_store_timeout",
            "The keychain did not answer.",
        )),
    }
}

fn vault_item(base: &str, entry: &str) -> (String, ItemKind) {
    match base {
        SERVICE => (
            format!("signin/{entry}"),
            if entry.starts_with(BACKUP_PREFIX) {
                ItemKind::ImportBackup
            } else {
                ItemKind::Signin
            },
        ),
        PAYMENT_SERVICE => (format!("card/{entry}"), ItemKind::Card),
        _ => (format!("profile/{entry}"), ItemKind::Profile),
    }
}

async fn vault(state: &Arc<HttpState>) -> Result<Option<Arc<ProductVault>>, HttpError> {
    let root = root(state).ok_or_else(unavailable)?;
    let vault = shared(&root);
    let owned = vault.clone();
    match tokio::time::timeout(
        STORE_TIMEOUT,
        tokio::task::spawn_blocking(move || owned.active()),
    )
    .await
    {
        Ok(Ok(Ok(active))) => Ok(active.then_some(vault)),
        _ => Err(HttpError::public(
            409,
            "vault_locked",
            "Butler Vault is locked.",
        )),
    }
}

fn key_in(state: &HttpState, base: &str, entry: &str) -> Result<SecretKey, HttpError> {
    let root = root(state).ok_or_else(unavailable)?;
    SecretKey::new(&service_in(&root, base), entry).map_err(|_| unavailable())
}

/// A vault item's secret under another module's service (payment, autofill).
pub(super) async fn get_in(
    state: &Arc<HttpState>,
    base: &str,
    entry: &str,
) -> Result<Option<SecretText>, HttpError> {
    if let Some(vault) = vault(state).await? {
        let (id, _) = vault_item(base, entry);
        return blocking(state, move || vault.get(&id)).await;
    }
    let store = store(state).await?;
    let key = key_in(state, base, entry)?;
    if base == AUTOFILL_SERVICE {
        let legacy = key_in(state, LEGACY_TRAVELER_SERVICE, entry)?;
        let migrated = state.signin_secrets.migrated.clone();
        let entry = entry.to_owned();
        return blocking(state, move || {
            let mut done = migrated
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if done.contains(&entry) {
                return store.get(&key);
            }
            let current = store.get(&key)?;
            let old = store.get(&legacy)?;
            if let Some(old) = old {
                if current.is_none() {
                    store.set(&key, old.expose())?;
                }
                // Confirm the copied bytes before deleting legacy data; preserve a newer destination.
                let copied = store.get(&key)?;
                if copied
                    .as_ref()
                    .is_some_and(|value| current.is_some() || value.expose() == old.expose())
                {
                    store.delete(&legacy)?;
                    done.insert(entry);
                    return Ok(copied);
                }
                return Ok(current);
            }
            done.insert(entry);
            Ok(current)
        })
        .await;
    }
    blocking(state, move || store.get(&key)).await
}

pub(super) async fn set_in(
    state: &Arc<HttpState>,
    base: &str,
    entry: &str,
    secret: SecretText,
) -> Result<(), HttpError> {
    if let Some(vault) = vault(state).await? {
        let (id, kind) = vault_item(base, entry);
        return blocking(state, move || vault.put(&id, kind, secret)).await;
    }
    let store = store(state).await?;
    let key = key_in(state, base, entry)?;
    blocking(state, move || store.set(&key, secret.expose())).await
}

pub(super) async fn delete_in(
    state: &Arc<HttpState>,
    base: &str,
    entry: &str,
) -> Result<bool, HttpError> {
    if let Some(vault) = vault(state).await? {
        let (id, _) = vault_item(base, entry);
        return blocking(state, move || vault.delete(&id)).await;
    }
    if base == AUTOFILL_SERVICE {
        get_in(state, base, entry).await?;
    }
    let store = store(state).await?;
    let key = key_in(state, base, entry)?;
    blocking(state, move || store.delete(&key)).await
}

pub(super) async fn get(
    state: &Arc<HttpState>,
    entry: &str,
) -> Result<Option<SecretText>, HttpError> {
    get_in(state, SERVICE, entry).await
}

pub(super) async fn set(
    state: &Arc<HttpState>,
    entry: &str,
    secret: SecretText,
) -> Result<(), HttpError> {
    set_in(state, SERVICE, entry, secret).await
}

pub(super) async fn delete(state: &Arc<HttpState>, entry: &str) -> Result<bool, HttpError> {
    delete_in(state, SERVICE, entry).await
}

/// Run once for each existing profile, also before a user deletes an unused item.
pub(super) async fn migrate_profile(state: &Arc<HttpState>, id: &str) -> Result<(), HttpError> {
    if vault(state).await?.is_some() {
        return Ok(());
    }
    let done = state
        .signin_secrets
        .migrated
        .lock()
        .map_err(|_| HttpError::Internal)?
        .contains(id);
    if !done {
        get_in(state, AUTOFILL_SERVICE, id).await?;
    }
    Ok(())
}
