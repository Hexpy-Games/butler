//! Read-time fallback for the two global surfaces, using only point lookups.
use super::{conversation_background, wallpaper};
use crate::gateway::{GatewayApplicationError, wallpaper_modules::WallpaperModules};
use serde_json::Value;

impl super::super::AppApplication {
    pub(super) async fn resolve_background_sources(
        &self,
        mut view: Value,
    ) -> Result<Value, GatewayApplicationError> {
        for key in [wallpaper::KEY, conversation_background::KEY] {
            if !self.background_source_exists(&view[key]["source"]).await? {
                view[key]["source"] = wallpaper::default_source();
            }
        }
        Ok(view)
    }

    async fn background_source_exists(
        &self,
        source: &Value,
    ) -> Result<bool, GatewayApplicationError> {
        match source.get("kind").and_then(Value::as_str) {
            Some("image") => {
                let asset = source
                    .get("asset")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !self.wallpaper_asset_exists(asset.to_owned()).await? {
                    return Ok(false);
                }
                self.background_module_exists(source.get("filter")).await
            }
            Some("live") => self.background_module_exists(Some(source)).await,
            _ => Ok(true),
        }
    }

    async fn background_module_exists(
        &self,
        source: Option<&Value>,
    ) -> Result<bool, GatewayApplicationError> {
        let Some(id) = source.and_then(|v| v.get("module")).and_then(Value::as_str) else {
            return Ok(true);
        };
        if WallpaperModules::builtin().get(id).is_some() {
            return Ok(true);
        }
        self.wallpapers.module_exists(id.to_owned()).await
    }
}
