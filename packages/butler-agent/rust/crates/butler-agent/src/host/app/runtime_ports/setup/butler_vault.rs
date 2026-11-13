//! Butler Vault choice and its public status.
use crate::host::{plugins::Plugins, runtime::vault_switch};
use butler_gateway::gateway::{
    ApplicationFuture, ButlerVaultCounts, ButlerVaultView, GatewayApplicationError,
};
use butler_models::models::{FileOverride, SecretStoreFacts, vault_uses_system_store};
use butler_platform::secrets::{SecretStore, SecretText, sealed_available};
use butler_vault::vault::{ItemKind, VaultError, shared};
use std::{path::PathBuf, sync::Arc};

pub(super) fn view(root: PathBuf) -> ApplicationFuture<ButlerVaultView> {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || {
            let vault = shared(&root);
            let declined = vault.declined();
            let (state, counts) = match vault.active() {
                Ok(true) => match vault.item_kinds() {
                    Ok(kinds) => {
                        let mut counts = ButlerVaultCounts::default();
                        for kind in kinds {
                            match kind {
                                ItemKind::ApiKey => counts.api_key += 1,
                                ItemKind::Signin => counts.signin += 1,
                                ItemKind::Card => counts.card += 1,
                                ItemKind::Profile => counts.profile += 1,
                                ItemKind::PluginSecret => counts.plugin += 1,
                                ItemKind::ImportBackup => (),
                            }
                        }
                        ("protected", Some(counts))
                    }
                    Err(_) => ("locked", None),
                },
                Ok(false) => ("off", None),
                Err(_) => ("locked", None),
            };
            // Once the vault is in use, how it opens answers this without
            // touching the system store again; only an off vault probes.
            let available = if state == "off" {
                opens_unattended(&root)
            } else {
                vault.unattended()
            };
            ButlerVaultView {
                state,
                available,
                declined,
                counts,
                unlock: vault.unlock_kind(),
                has_password: vault.has_password(),
            }
        })
        .await
        .map_err(GatewayApplicationError::internal_from)
    })
}

/// Whether a vault here could open without a password (keychain or sealed).
fn opens_unattended(root: &std::path::Path) -> bool {
    let facts = SecretStoreFacts::for_data_root(root);
    facts.file_override != FileOverride::Honored
        && ((vault_uses_system_store(root, facts) && SecretStore::system().is_ok())
            || sealed_available())
}

pub(super) fn enable(
    root: PathBuf,
    plugins: Arc<Plugins>,
    password: Option<SecretText>,
) -> ApplicationFuture<ButlerVaultView> {
    Box::pin(async move {
        let data_root = root.clone();
        tokio::task::spawn_blocking(move || vault_switch::enable(&data_root, &plugins, password))
            .await
            .map_err(|_| {
                error(
                    "vault_enable_failed",
                    "Butler Vault could not be turned on.",
                )
            })?
            .map_err(|failure| password_error(&failure))?;
        view(root).await
    })
}

pub(super) fn unlock(root: PathBuf, password: SecretText) -> ApplicationFuture<ButlerVaultView> {
    Box::pin(async move {
        let vault = shared(&root);
        tokio::task::spawn_blocking(move || vault.unlock_with_password(&password))
            .await
            .map_err(GatewayApplicationError::internal_from)?
            .map_err(|failure| password_error(&failure))?;
        view(root).await
    })
}

pub(super) fn password(
    root: PathBuf,
    current: SecretText,
    new: SecretText,
) -> ApplicationFuture<ButlerVaultView> {
    Box::pin(async move {
        let vault = shared(&root);
        tokio::task::spawn_blocking(move || vault.change_password(&current, &new))
            .await
            .map_err(GatewayApplicationError::internal_from)?
            .map_err(|failure| password_error(&failure))?;
        view(root).await
    })
}

fn password_error(failure: &VaultError) -> GatewayApplicationError {
    let (status, code, message) = match failure {
        VaultError::NotSystemStore => (
            409,
            "vault_password_required",
            "A master password is required.",
        ),
        VaultError::WrongPassword => (403, "vault_wrong_password", "The password is wrong."),
        VaultError::WeakPassword => (400, "vault_weak_password", "The password is too weak."),
        _ => return error("vault_enable_failed", "Butler Vault could not be opened."),
    };
    GatewayApplicationError::Public {
        status,
        code: code.into(),
        message: message.into(),
        source: None,
    }
}

pub(super) fn decline(root: PathBuf) -> ApplicationFuture<ButlerVaultView> {
    Box::pin(async move {
        let data_root = root.clone();
        tokio::task::spawn_blocking(move || shared(&data_root).decline())
            .await
            .map_err(|_| {
                error(
                    "vault_decline_failed",
                    "Butler Vault choice could not be saved.",
                )
            })?
            .map_err(|_| {
                error(
                    "vault_decline_failed",
                    "Butler Vault choice could not be saved.",
                )
            })?;
        view(root).await
    })
}

fn error(code: &'static str, message: &'static str) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 500,
        code: code.into(),
        message: message.into(),
        source: None,
    }
}
