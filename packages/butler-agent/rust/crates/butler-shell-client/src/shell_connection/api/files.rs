use crate::{Download, Error, ShellClient, Upload};
use reqwest::Method;
use serde_json::Value;

impl ShellClient {
    /// GET /artifacts?session_id
    pub async fn list_artifacts(&self, session_id: &str) -> Result<Value, Error> {
        self.json(
            Method::GET,
            &["artifacts"],
            &[("session_id", session_id.to_string())],
            None,
        )
        .await
    }
    /// GET /message-files/{file_id}
    pub async fn download_message_file(&self, file_id: &str) -> Result<Download, Error> {
        self.download(Method::GET, &["message-files", file_id], &[])
            .await
    }
    /// GET /message-files/{file_id}/view
    pub async fn get_message_file_view(&self, file_id: &str) -> Result<Value, Error> {
        self.json(Method::GET, &["message-files", file_id, "view"], &[], None)
            .await
    }
    /// GET /outputs/{output_id}/view?revision
    pub async fn get_output_view(
        &self,
        output_id: &str,
        revision: Option<u64>,
    ) -> Result<Value, Error> {
        let mut query = Vec::new();
        if let Some(value) = revision {
            query.push(("revision", value.to_string()));
        }
        self.json(Method::GET, &["outputs", output_id, "view"], &query, None)
            .await
    }
    /// GET /previews/{preview_id}/view
    pub async fn get_preview_view(&self, preview_id: &str) -> Result<Value, Error> {
        self.json(Method::GET, &["previews", preview_id, "view"], &[], None)
            .await
    }
    /// GET /message-assets/{id}?download
    pub async fn download_message_asset(
        &self,
        id: &str,
        download: Option<u8>,
    ) -> Result<Download, Error> {
        let mut query = Vec::new();
        if let Some(value) = download {
            query.push(("download", value.to_string()));
        }
        self.download(Method::GET, &["message-assets", id], &query)
            .await
    }
    /// GET /message-assets/{id}/meta
    pub async fn get_message_asset_meta(&self, id: &str) -> Result<Value, Error> {
        self.json(Method::GET, &["message-assets", id, "meta"], &[], None)
            .await
    }
    /// GET /message-assets/{id}/versions
    pub async fn get_message_asset_versions(&self, id: &str) -> Result<Value, Error> {
        self.json(Method::GET, &["message-assets", id, "versions"], &[], None)
            .await
    }
    /// GET /browser-stills/{id}?session_id&wait
    pub async fn get_browser_stills(
        &self,
        id: &str,
        session_id: &str,
        wait: bool,
    ) -> Result<Value, Error> {
        self.json(
            Method::GET,
            &["browser-stills", id],
            &[
                ("session_id", session_id.to_string()),
                ("wait", u8::from(wait).to_string()),
            ],
            None,
        )
        .await
    }
    /// GET /favicons?host
    pub async fn get_favicon(&self, host: &str) -> Result<Download, Error> {
        self.download(Method::GET, &["favicons"], &[("host", host.to_string())])
            .await
    }
    /// POST /internal/opened-files
    pub async fn record_opened_file(&self, body: &Value) -> Result<Value, Error> {
        self.json(Method::POST, &["internal", "opened-files"], &[], Some(body))
            .await
    }
    /// GET /settings/image-model
    pub async fn get_image_model_settings(&self) -> Result<Value, Error> {
        self.json(Method::GET, &["settings", "image-model"], &[], None)
            .await
    }
    /// PUT /settings/image-model
    pub async fn update_image_model_settings(&self, body: &Value) -> Result<Value, Error> {
        self.json(Method::PUT, &["settings", "image-model"], &[], Some(body))
            .await
    }
    /// POST /message-files (multipart: file, session_id).
    pub async fn upload_message_file(
        &self,
        session_id: &str,
        file: &Upload,
    ) -> Result<Value, Error> {
        self.upload(&["message-files"], &[], &[("session_id", session_id)], file)
            .await
    }
    /// POST /message-assets/masks?session&for (image/png).
    pub async fn upload_image_mask(
        &self,
        session: &str,
        image: &str,
        bytes: Vec<u8>,
    ) -> Result<Value, Error> {
        self.bytes_json(
            &["message-assets", "masks"],
            &[("session", session.into()), ("for", image.into())],
            "image/png",
            bytes,
        )
        .await
    }
}
