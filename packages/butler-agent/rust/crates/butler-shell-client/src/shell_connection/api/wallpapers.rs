use crate::{Download, Error, ShellClient, Upload};
use reqwest::Method;
use serde_json::Value;

impl ShellClient {
    /// GET /wallpapers
    pub async fn list_wallpapers(&self) -> Result<Value, Error> {
        self.json(Method::GET, &["wallpapers"], &[], None).await
    }
    /// DELETE /wallpapers/{id}
    pub async fn delete_wallpaper(&self, id: &str) -> Result<Value, Error> {
        self.json(Method::DELETE, &["wallpapers", id], &[], None)
            .await
    }
    /// GET /wallpapers/{id}
    pub async fn read_wallpaper_image(&self, id: &str) -> Result<Download, Error> {
        self.download(Method::GET, &["wallpapers", id], &[]).await
    }
    /// GET /wallpapers/{id}/thumbnail
    pub async fn read_wallpaper_thumbnail(&self, id: &str) -> Result<Download, Error> {
        self.download(Method::GET, &["wallpapers", id, "thumbnail"], &[])
            .await
    }
    /// GET /wallpaper-modules
    pub async fn list_wallpaper_modules(&self) -> Result<Value, Error> {
        self.json(Method::GET, &["wallpaper-modules"], &[], None)
            .await
    }
    /// DELETE /wallpaper-modules/{id}
    pub async fn delete_wallpaper_module(&self, id: &str) -> Result<Value, Error> {
        self.json(Method::DELETE, &["wallpaper-modules", id], &[], None)
            .await
    }
    /// GET /wallpaper-modules/{id}/shader
    pub async fn read_wallpaper_module_shader(&self, id: &str) -> Result<Download, Error> {
        self.download(Method::GET, &["wallpaper-modules", id, "shader"], &[])
            .await
    }
    /// GET /wallpaper-modules/{id}/overlay
    pub async fn read_wallpaper_module_overlay(&self, id: &str) -> Result<Download, Error> {
        self.download(Method::GET, &["wallpaper-modules", id, "overlay"], &[])
            .await
    }
    /// GET /wallpaper-modules/{id}/image
    pub async fn read_wallpaper_module_image(&self, id: &str) -> Result<Download, Error> {
        self.download(Method::GET, &["wallpaper-modules", id, "image"], &[])
            .await
    }
    /// POST /wallpaper-modules/{id}/status
    pub async fn report_wallpaper_module_status(
        &self,
        id: &str,
        body: &Value,
    ) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["wallpaper-modules", id, "status"],
            &[],
            Some(body),
        )
        .await
    }
    /// POST /wallpapers (multipart: file).
    pub async fn upload_wallpaper(&self, file: &Upload) -> Result<Value, Error> {
        self.upload(&["wallpapers"], &[], &[], file).await
    }
    /// POST /wallpaper-modules/import?replace=1 (multipart: file).
    pub async fn import_wallpaper_module(
        &self,
        replace: bool,
        file: &Upload,
    ) -> Result<Value, Error> {
        let query = replace.then(|| ("replace", "1".into()));
        self.upload(
            &["wallpaper-modules", "import"],
            query.as_slice(),
            &[],
            file,
        )
        .await
    }
}
