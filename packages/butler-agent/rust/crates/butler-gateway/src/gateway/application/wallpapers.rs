//! Wallpaper assets and writes: metadata rows in App SQLite, files through
//! [`AppWallpaperFiles`](crate::gateway::wallpaper_store::AppWallpaperFiles).
//! Deletion and the settings PATCH asset check both hold the settings update
//! lock, so an asset cannot be deleted while a new reference to it lands.
//! Deletion scans references and deletes in one App SQLite operation, and a
//! project preferences PATCH checks the asset in its write transaction on the
//! same lane, so those two cannot interleave either.

mod agent;
mod change;
mod module_status;
mod modules;
mod references;
mod rows;

use bytes::Bytes;
use rusqlite::Connection;
use serde_json::{Value, json};

use super::{AppApplication, AppStorageError, app_error};
use crate::gateway::{
    AppWallpaperAsset, AppWallpaperChange, AppWallpaperFile, AppWallpaperModuleShader,
    AppWallpaperModuleStatusReport, AppWallpaperRejection, AppWallpaperSetRequest,
    AppWallpaperVariant, ApplicationFuture, GatewayApplicationError, GatewayWallpapers,
    wallpapers::{AppWallpaperModuleSaveRequest, AppWallpaperModuleSaved, is_asset_id, not_found},
};
#[cfg(test)]
pub(super) use agent::default_dim_for;
pub(super) use change::{EVENT as CHANGED, WallpaperOrigin, payload as change_payload};
use rows::AssetRow;

impl AppApplication {
    /// Runs `source` through the pipeline and records the asset. The files
    /// are written before the row, so a listed asset always has its files.
    async fn store_wallpaper(
        &self,
        source: Bytes,
        message_file_id: Option<String>,
    ) -> Result<AppWallpaperAsset, GatewayApplicationError> {
        let uuid = self.dependencies.identity_clock.new_uuid();
        let id = format!("wp_{}", uuid.replace('-', "").to_ascii_lowercase());
        if !is_asset_id(&id) {
            return Err(GatewayApplicationError::internal());
        }
        let stored = self.wallpapers.store(id.clone(), source).await?;
        let row = AssetRow {
            asset: AppWallpaperAsset {
                id,
                width: stored.width,
                height: stored.height,
                luminance: stored.luminance,
                color: stored.color,
                bytes: stored.bytes,
                created_at: self.dependencies.identity_clock.now_iso(),
            },
            mime_type: stored.mime_type,
            thumbnail_mime_type: stored.thumbnail_mime_type,
        };
        let asset = row.asset.clone();
        let files = (row.mime_type.clone(), row.thumbnail_mime_type.clone());
        let inserted = self
            .storage
            .execute(move |db| rows::insert(db, &row, message_file_id.as_deref()))
            .await;
        if let Err(error) = inserted {
            let _ = self.wallpapers.remove(asset.id, files.0, files.1).await;
            return Err(app_error(error));
        }
        Ok(asset)
    }

    async fn read_wallpaper_owned(
        &self,
        id: String,
        variant: AppWallpaperVariant,
    ) -> Result<AppWallpaperFile, GatewayApplicationError> {
        let lookup = id.clone();
        let row = self
            .storage
            .execute(move |db| rows::get(db, &lookup))
            .await
            .map_err(app_error)?
            .ok_or_else(not_found)?;
        let (mime_type, etag) = match variant {
            AppWallpaperVariant::Image => (row.mime_type, format!("\"{id}\"")),
            AppWallpaperVariant::Thumbnail => (row.thumbnail_mime_type, format!("\"{id}-thumb\"")),
        };
        let bytes = self.wallpapers.read(id, mime_type.clone(), variant).await?;
        Ok(AppWallpaperFile {
            mime_type,
            etag,
            bytes,
        })
    }

    async fn delete_wallpaper_owned(
        &self,
        id: String,
    ) -> Result<AppWallpaperAsset, GatewayApplicationError> {
        let row = {
            let _settings = self.settings_update_lock.lock().await;
            self.storage
                .execute(move |db| delete_unreferenced(db, &id))
                .await
                .map_err(app_error)??
        };
        // The row is gone, so a failed removal leaves only unreachable files.
        let _ = self
            .wallpapers
            .remove(row.asset.id.clone(), row.mime_type, row.thumbnail_mime_type)
            .await;
        Ok(row.asset)
    }

    /// The stored asset `id`, if any.
    async fn wallpaper_asset(
        &self,
        id: String,
    ) -> Result<Option<AppWallpaperAsset>, GatewayApplicationError> {
        let row = self.storage.execute(move |db| rows::get(db, &id)).await;
        Ok(row.map_err(app_error)?.map(|row| row.asset))
    }

    /// The asset promoted from message file `file_id`: promoted on first use,
    /// then reused, so a retried request stores one image.
    async fn wallpaper_from_attachment(
        &self,
        file_id: String,
    ) -> Result<AppWallpaperAsset, GatewayApplicationError> {
        let lookup = file_id.clone();
        let promoted = self
            .storage
            .execute(move |db| rows::from_message_file(db, &lookup))
            .await
            .map_err(app_error)?;
        if let Some(row) = promoted {
            return Ok(row.asset);
        }
        let download = self.download_message_file(file_id.clone()).await?;
        self.store_wallpaper(download.bytes, Some(file_id)).await
    }

    /// The global setting, the project's wallpaper and effective source when
    /// `project_id` is given, the modules with their status, where user
    /// modules are written, and the uploaded images.
    async fn wallpaper_overview_owned(
        &self,
        project_id: Option<String>,
    ) -> Result<Value, GatewayApplicationError> {
        let settings = self.worker_profile_settings().await?;
        let global = settings.get("wallpaper").cloned().unwrap_or(Value::Null);
        let images: Vec<_> = self
            .storage
            .execute(|db| rows::list(db))
            .await
            .map_err(app_error)?
            .into_iter()
            .map(|asset| {
                json!({"id": asset.id, "width": asset.width, "height": asset.height,
                       "luminance": asset.luminance, "color": asset.color})
            })
            .collect();
        let mut overview = json!({
            "global": global,
            "modules": self.module_entries(true).await?,
            "userModuleDirectory": self.wallpapers.modules_root().to_string_lossy(),
            "images": images,
        });
        if let Some(id) = project_id {
            let wallpaper = self.project_wallpaper(&id).await?;
            let effective = if wallpaper == json!("inherit") {
                global.get("source").cloned().unwrap_or(Value::Null)
            } else {
                wallpaper.clone()
            };
            overview["project"] = json!({"id": id, "wallpaper": wallpaper, "effective": effective});
        }
        Ok(overview)
    }

    /// Whether a settings PATCH may point `wallpaper.source` at `id`. The
    /// caller holds the settings update lock.
    pub(super) async fn wallpaper_asset_exists(
        &self,
        id: String,
    ) -> Result<bool, GatewayApplicationError> {
        self.storage
            .execute(move |db| asset_exists(db, &id))
            .await
            .map_err(app_error)
    }
}

/// Whether the store holds asset `id`.
pub(super) fn asset_exists(db: &Connection, id: &str) -> Result<bool, AppStorageError> {
    rows::get(db, id).map(|row| row.is_some())
}

fn delete_unreferenced(
    db: &mut Connection,
    id: &str,
) -> Result<Result<AssetRow, GatewayApplicationError>, AppStorageError> {
    let Some(row) = rows::get(db, id)? else {
        return Ok(Err(not_found()));
    };
    let references = references::find(db, id)?;
    if !references.is_empty() {
        return Ok(Err(GatewayApplicationError::public(
            409,
            "wallpaper_in_use",
            format!("Wallpaper is in use by {}.", references.join(", ")),
        )));
    }
    rows::delete(db, id)?;
    Ok(Ok(row))
}

impl GatewayWallpapers for AppApplication {
    fn upload_wallpaper(&self, source: Bytes) -> ApplicationFuture<AppWallpaperAsset> {
        let this = self.clone_handle();
        Box::pin(async move { this.store_wallpaper(source, None).await })
    }
    fn promote_message_file_to_wallpaper(
        &self,
        file_id: String,
    ) -> ApplicationFuture<AppWallpaperAsset> {
        let this = self.clone_handle();
        Box::pin(async move {
            let download = this.download_message_file(file_id.clone()).await?;
            this.store_wallpaper(download.bytes, Some(file_id)).await
        })
    }
    fn list_wallpapers(&self) -> ApplicationFuture<Vec<AppWallpaperAsset>> {
        let storage = self.storage.clone();
        Box::pin(async move {
            storage
                .execute(|db| rows::list(db))
                .await
                .map_err(app_error)
        })
    }
    fn read_wallpaper(
        &self,
        id: String,
        variant: AppWallpaperVariant,
    ) -> ApplicationFuture<AppWallpaperFile> {
        let this = self.clone_handle();
        Box::pin(async move { this.read_wallpaper_owned(id, variant).await })
    }
    fn delete_wallpaper(&self, id: String) -> ApplicationFuture<AppWallpaperAsset> {
        let this = self.clone_handle();
        Box::pin(async move { this.delete_wallpaper_owned(id).await })
    }
    fn wallpaper_modules(&self) -> ApplicationFuture<Vec<Value>> {
        let this = self.clone_handle();
        Box::pin(async move { this.module_entries(false).await })
    }
    fn wallpaper_module_shader(&self, id: String) -> ApplicationFuture<AppWallpaperModuleShader> {
        let this = self.clone_handle();
        Box::pin(async move { this.module_shader(id).await })
    }
    fn wallpaper_module_overlay(&self, id: String) -> ApplicationFuture<AppWallpaperModuleShader> {
        let this = self.clone_handle();
        Box::pin(async move { this.module_overlay(id).await })
    }
    fn wallpaper_module_image(&self, id: String) -> ApplicationFuture<AppWallpaperFile> {
        let this = self.clone_handle();
        Box::pin(async move { this.module_image(id).await })
    }
    fn report_wallpaper_module_status(
        &self,
        id: String,
        report: AppWallpaperModuleStatusReport,
    ) -> ApplicationFuture<Value> {
        let this = self.clone_handle();
        Box::pin(async move { this.report_module_status(id, report).await })
    }
    fn import_wallpaper_module(&self, archive: Bytes) -> ApplicationFuture<Value> {
        let this = self.clone_handle();
        Box::pin(async move { this.import_module(archive).await })
    }
    fn delete_wallpaper_module(&self, id: String) -> ApplicationFuture<()> {
        let this = self.clone_handle();
        Box::pin(async move { this.delete_module(id).await })
    }
    fn save_wallpaper_module(
        &self,
        request: AppWallpaperModuleSaveRequest,
    ) -> ApplicationFuture<Result<AppWallpaperModuleSaved, AppWallpaperRejection>> {
        let this = self.clone_handle();
        Box::pin(async move { this.save_module(request, modules::SAVE_CHECK_WAIT).await })
    }
    fn wallpaper_overview(&self, project_id: Option<String>) -> ApplicationFuture<Value> {
        let this = self.clone_handle();
        Box::pin(async move { this.wallpaper_overview_owned(project_id).await })
    }
    fn set_wallpaper(
        &self,
        request: AppWallpaperSetRequest,
    ) -> ApplicationFuture<Result<AppWallpaperChange, AppWallpaperRejection>> {
        let this = self.clone_handle();
        Box::pin(async move { this.set_wallpaper_owned(request).await })
    }
}
