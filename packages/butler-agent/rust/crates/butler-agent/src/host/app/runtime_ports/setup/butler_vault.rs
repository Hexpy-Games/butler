//! Butler Vault choice and its public status.
use crate::host::{plugins::Plugins, runtime::vault_switch};
use butler_gateway::gateway::{
    ApplicationFuture, ButlerVaultCounts, ButlerVaultView, GatewayApplicationError,
};
use butler_models::models::{SecretStoreFacts, vault_uses_system_store};
use butler_vault::vault::{ItemKind, shared};
use std::{path::PathBuf, sync::Arc};

pub(super) fn view(root: PathBuf) -> ApplicationFuture<ButlerVaultView> {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || {
            let available = vault_uses_system_store(&root, SecretStoreFacts::for_data_root(&root));
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
            ButlerVaultView {
                state,
                available,
                declined,
                counts,
            }
        })
        .await
        .map_err(GatewayApplicationError::internal_from)
    })
}

pub(super) fn enable(root: PathBuf, plugins: Arc<Plugins>) -> ApplicationFuture<ButlerVaultView> {
    Box::pin(async move {
        let data_root = root.clone();
        tokio::task::spawn_blocking(move || vault_switch::enable(&data_root, &plugins))
            .await
            .map_err(|_| {
                error(
                    "vault_enable_failed",
                    "Butler Vault could not be turned on.",
                )
            })?
            .map_err(|_| {
                error(
                    "vault_enable_failed",
                    "Butler Vault could not be turned on.",
                )
            })?;
        view(root).await
    })
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
