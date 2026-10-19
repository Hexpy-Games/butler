//! App-owned content assets. No timers, disk thumbnails or duplicate file writes.
mod cache;
mod store;
use super::{AppApplication, GatewayApplicationError, app_error};
use base64::{Engine, engine::general_purpose::STANDARD};
use cache::Derivatives;
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::sync::Arc;

pub enum AppAssetCommand {
    Collect {
        session: String,
        bytes: Vec<u8>,
        alt: String,
        nearby_text: String,
        source_url: String,
    },
    Lookup {
        ids: Vec<String>,
    },
    Read {
        id: String,
        width: Option<u32>,
    },
    Sweep,
}
#[derive(Clone, Default)]
pub(super) struct AssetCache(Arc<Mutex<Derivatives>>);
impl AppApplication {
    pub(super) async fn assets_owned(
        &self,
        command: AppAssetCommand,
    ) -> Result<Value, GatewayApplicationError> {
        match command {
            AppAssetCommand::Collect {
                session,
                bytes,
                alt,
                nearby_text,
                source_url,
            } => {
                let image = tokio::task::spawn_blocking(move || {
                    butler_runtime::browser::normalize_image(&bytes)
                })
                .await
                .map_err(|_| GatewayApplicationError::internal())?
                .map_err(|code| {
                    GatewayApplicationError::public(400, code, "Image could not be collected.")
                })?;
                let root = self.butler_data.join(butler_platform::data_paths::ASSETS);
                self.storage
                    .execute(move |db| {
                        store::collect(db, &root, &session, &image, &alt, &nearby_text, &source_url)
                    })
                    .await
                    .map_err(app_error)
            }
            AppAssetCommand::Lookup { ids } => self
                .storage
                .read(move |db| store::lookup(db, &ids))
                .await
                .map_err(app_error),
            AppAssetCommand::Read { id, width } => self.read_asset(id, width).await,
            AppAssetCommand::Sweep => {
                let root = self.butler_data.join(butler_platform::data_paths::ASSETS);
                self.storage
                    .execute(move |db| store::sweep(db, &root))
                    .await
                    .map_err(app_error)?;
                self.asset_cache.0.lock().clear();
                Ok(json!({"ok":true}))
            }
        }
    }
    async fn read_asset(
        &self,
        id: String,
        width: Option<u32>,
    ) -> Result<Value, GatewayApplicationError> {
        let root = self.butler_data.join(butler_platform::data_paths::ASSETS);
        let identity = id.clone();
        let hash = self
            .storage
            .read(move |db| store::hash(db, &identity))
            .await
            .map_err(|e| GatewayApplicationError::public(404, e.code(), "Image not found."))?;
        let key = format!("{hash}:{}", width.unwrap_or(0));
        let cached = self.asset_cache.0.lock().get(&key);
        let bytes = if let Some(bytes) = cached {
            bytes
        } else {
            let bytes = tokio::task::spawn_blocking(move || {
                store::resize(store::read(&root, &hash)?, width)
            })
            .await
            .map_err(|_| GatewayApplicationError::internal())?
            .map_err(app_error)?;
            self.asset_cache.0.lock().insert(key, bytes.clone());
            bytes
        };
        Ok(json!({"data":STANDARD.encode(bytes),"mime":"image/jpeg"}))
    }
}
