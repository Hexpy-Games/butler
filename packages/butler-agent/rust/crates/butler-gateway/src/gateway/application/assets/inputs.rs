//! Indexed chat ownership checks precede every input read or lossless import.
use super::*;
use rusqlite::{OptionalExtension, params};
impl AppApplication {
    pub(super) async fn resolve_input(
        &self,
        session: String,
        id: String,
        mask_for: Option<String>,
    ) -> Result<Value, GatewayApplicationError> {
        let key = id.clone();
        let chat = session.clone();
        if id.starts_with("img_") {
            let meta=self.storage.read(move|db|{
                let owned=db.query_row("SELECT 1 FROM app_asset_refs WHERE asset_id=?1 AND owner_kind='chat' AND owner_id=?2",params![key,chat],|_|Ok(())).optional().map_err(super::super::AppStorageError::sqlite)?.is_some();
                if !owned { return Err(store::failed("image_not_in_chat")); }
                generated::meta(db,&key)
            }).await.map_err(|_|not_in_chat())?;
            let valid = match mask_for {
                Some(parent) => meta["kind"] == "mask" && meta["parent_id"] == parent,
                None => meta["kind"] != "mask",
            };
            if !valid {
                return Err(GatewayApplicationError::public(
                    400,
                    "image_input_invalid",
                    "Invalid image input.",
                ));
            }
            let mut result = self.read_asset(id.clone(), None).await?;
            result["id"] = json!(id);
            result["meta"] = meta;
            return Ok(result);
        }
        if mask_for.is_some() {
            return Err(not_in_chat());
        }
        let storage=self.storage.read(move|db|{
            db.query_row("SELECT f.storage_name FROM message_files f LEFT JOIN messages m ON m.id=f.message_id WHERE f.id=?1 AND f.kind='image' AND (f.owner_session_id=?2 OR m.chat_id=?2)",params![key,chat],|r|r.get::<_,String>(0)).optional().map_err(super::super::AppStorageError::sqlite)
        }).await.map_err(app_error)?.ok_or_else(not_in_chat)?;
        if std::path::Path::new(&storage).components().count() != 1 {
            return Err(not_in_chat());
        }
        let path = self
            .butler_data
            .join(butler_platform::data_paths::MESSAGE_FILES)
            .join(storage);
        let bytes = tokio::task::spawn_blocking(move || {
            use std::io::Read;
            let mut bytes = Vec::new();
            butler_platform::secure_fs::open_read_no_follow(&path)?.read_to_end(&mut bytes)?;
            Ok::<_, std::io::Error>(bytes)
        })
        .await
        .map_err(GatewayApplicationError::internal_from)?
        .map_err(GatewayApplicationError::internal_from)?;
        let meta = self
            .put_generated(
                session,
                bytes.clone(),
                GeneratedAssetKind::Original,
                None,
                None,
            )
            .await?;
        Ok(json!({"id":meta["id"],"meta":meta,"data":STANDARD.encode(bytes)}))
    }
}
fn not_in_chat() -> GatewayApplicationError {
    GatewayApplicationError::public(400, "image_not_in_chat", "Image is not in this chat.")
}
