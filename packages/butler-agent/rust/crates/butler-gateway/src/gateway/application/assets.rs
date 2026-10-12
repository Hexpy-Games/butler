//! App-owned content assets. No timers, disk thumbnails or duplicate file writes.
mod store;
use super::{AppApplication, GatewayApplicationError, app_error};
use base64::{Engine, engine::general_purpose::STANDARD};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::{collections::VecDeque, sync::Arc};

pub enum AppAssetCommand {
    Collect {
        session: String,
        bytes: Vec<u8>,
        alt: String,
        nearby_text: String,
        source_url: String,
    },
    Lookup {
        session: String,
        ids: Vec<String>,
    },
    Read {
        id: String,
        width: Option<u32>,
    },
    Sweep,
}
type Derivatives = VecDeque<(String, Vec<u8>)>;
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
                let root = self.butler_data.join("app-server/assets");
                self.storage
                    .execute(move |db| {
                        store::collect(db, &root, &session, &image, &alt, &nearby_text, &source_url)
                    })
                    .await
                    .map_err(app_error)
            }
            AppAssetCommand::Lookup { session, ids } => self
                .storage
                .read(move |db| store::lookup(db, &session, &ids))
                .await
                .map_err(app_error),
            AppAssetCommand::Read { id, width } => self.read_asset(id, width).await,
            AppAssetCommand::Sweep => {
                let root = self.butler_data.join("app-server/assets");
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
        let root = self.butler_data.join("app-server/assets");
        let identity = id.clone();
        let hash = self
            .storage
            .read(move |db| store::hash(db, &identity))
            .await
            .map_err(|e| GatewayApplicationError::public(404, e.code(), "Image not found."))?;
        let key = format!("{id}:{}", width.unwrap_or(0));
        let cached = {
            let mut cache = self.asset_cache.0.lock();
            cache
                .iter()
                .position(|(k, _)| *k == key)
                .and_then(|i| cache.remove(i))
                .map(|entry| {
                    let bytes = entry.1.clone();
                    cache.push_back(entry);
                    bytes
                })
        };
        let bytes = if let Some(bytes) = cached {
            bytes
        } else {
            let bytes = tokio::task::spawn_blocking(move || {
                store::resize(store::read(&root, &hash)?, width)
            })
            .await
            .map_err(|_| GatewayApplicationError::internal())?
            .map_err(app_error)?;
            let mut cache = self.asset_cache.0.lock();
            while cache.iter().map(|(_, b)| b.len()).sum::<usize>() + bytes.len() > 8 * 1024 * 1024
            {
                if cache.pop_front().is_none() {
                    break;
                }
            }
            cache.push_back((key, bytes.clone()));
            bytes
        };
        Ok(json!({"data":STANDARD.encode(bytes),"mime":"image/jpeg"}))
    }
}
