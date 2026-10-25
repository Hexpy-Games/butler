//! App-owned content assets. No timers, disk thumbnails or duplicate file writes.
mod cache;
mod composite;
pub use composite::{composite, mask_bounds};
mod generated;
mod inputs;
mod projection;
pub use generated::GeneratedAssetKind;
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
        pixel_ratio: f64,
        alt: String,
        nearby_text: String,
        source_url: String,
    },
    Project {
        value: Value,
    },
    Lookup {
        ids: Vec<String>,
    },
    Read {
        id: String,
        width: Option<u32>,
    },
    PutGenerated {
        session: String,
        bytes: Vec<u8>,
        kind: GeneratedAssetKind,
        parent_id: Option<String>,
        model_ref: Option<String>,
    },
    Meta {
        id: String,
    },
    Versions {
        id: String,
    },
    ResolveInput {
        session: String,
        id: String,
        mask_for: Option<String>,
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
                pixel_ratio,
                alt,
                nearby_text,
                source_url,
            } => {
                let image = tokio::task::spawn_blocking(move || {
                    butler_runtime::browser::normalize_image(&bytes).map(|mut image| {
                        image.pixel_ratio = pixel_ratio;
                        image
                    })
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
            AppAssetCommand::Project { value } => projection::execute(self.storage.clone(), value)
                .await
                .map_err(app_error),
            AppAssetCommand::Lookup { ids } => self
                .storage
                .read(move |db| store::lookup(db, &ids))
                .await
                .map_err(app_error),
            AppAssetCommand::Read { id, width } => self.read_asset(id, width).await,
            AppAssetCommand::PutGenerated {
                session,
                bytes,
                kind,
                parent_id,
                model_ref,
            } => {
                self.put_generated(session, bytes, kind, parent_id, model_ref)
                    .await
            }
            AppAssetCommand::Meta { id } => self
                .storage
                .read(move |db| generated::meta(db, &id))
                .await
                .map_err(asset_read_error),
            AppAssetCommand::Versions { id } => self
                .storage
                .read(move |db| generated::versions(db, &id))
                .await
                .map_err(app_error),
            AppAssetCommand::ResolveInput {
                session,
                id,
                mask_for,
            } => self.resolve_input(session, id, mask_for).await,
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
        let (hash, mime) = self
            .storage
            .read(move |db| store::identity(db, &identity))
            .await
            .map_err(|e| GatewayApplicationError::public(404, e.code(), "Image not found."))?;
        let key = format!("{hash}:{}", width.unwrap_or(0));
        let cached = self.asset_cache.0.lock().get(&key);
        let bytes = if let Some(bytes) = cached {
            bytes
        } else {
            let bytes = tokio::task::spawn_blocking(move || {
                store::resize(store::read(&root, &hash, &mime)?, width)
            })
            .await
            .map_err(|_| GatewayApplicationError::internal())?
            .map_err(app_error)?;
            self.asset_cache.0.lock().insert(key, bytes.clone());
            bytes
        };
        let mime = match image::guess_format(&bytes) {
            Ok(image::ImageFormat::Png) => "image/png",
            Ok(image::ImageFormat::WebP) => "image/webp",
            _ => "image/jpeg",
        };
        Ok(json!({"data":STANDARD.encode(bytes),"mime":mime}))
    }
}

impl AppApplication {
    pub async fn put_generated(
        &self,
        session: String,
        bytes: Vec<u8>,
        kind: GeneratedAssetKind,
        parent_id: Option<String>,
        model_ref: Option<String>,
    ) -> Result<Value, GatewayApplicationError> {
        let image = tokio::task::spawn_blocking(move || generated::validate(bytes))
            .await
            .map_err(GatewayApplicationError::internal_from)?
            .map_err(|code| GatewayApplicationError::public(400, code, "Invalid image."))?;
        if kind == GeneratedAssetKind::Mask {
            let parent = parent_id.clone().ok_or_else(|| {
                GatewayApplicationError::public(400, "image_mask_invalid", "Invalid mask.")
            })?;
            let meta = self
                .storage
                .read(move |db| generated::meta(db, &parent))
                .await
                .map_err(app_error)?;
            if !image.valid_mask(&meta) {
                return Err(GatewayApplicationError::public(
                    400,
                    "image_mask_invalid",
                    "Invalid mask.",
                ));
            }
        }
        let root = self.butler_data.join(butler_platform::data_paths::ASSETS);
        self.storage
            .execute(move |db| {
                generated::put_generated(
                    db,
                    &root,
                    &session,
                    &image,
                    kind,
                    parent_id,
                    model_ref.as_deref(),
                )
            })
            .await
            .map_err(app_error)
    }
}

fn asset_read_error(error: super::AppStorageError) -> GatewayApplicationError {
    if error.code() == "message_file_not_found" {
        GatewayApplicationError::public(404, "asset_not_found", "Image not found.")
    } else {
        app_error(error)
    }
}

pub(super) fn execute(
    this: AppApplication,
    command: AppAssetCommand,
) -> super::ApplicationFuture<Value> {
    Box::pin(async move { this.assets_owned(command).await })
}
