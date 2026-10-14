//! Successful collection receipts become explicit parent input media ids.
use super::*;
use rusqlite::Connection;
pub(super) fn delivery_assets(db: &Connection, turn: &str) -> Result<String, StorageError> {
    let mut query = db.prepare("SELECT json_extract(result_json,'$.id') FROM btcc_guided_tool_calls WHERE turn_id=?1 AND tool_name='image_collect' AND json_valid(result_json) AND json_extract(result_json,'$.status')='ok' ORDER BY started_at,rowid").map_err(StorageError::sqlite)?;
    let ids = query
        .query_map([turn], |r| r.get::<_, String>(0))
        .map_err(StorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::sqlite)?;
    if ids.is_empty() {
        return Ok(String::new());
    }
    let ids = serde_json::to_string(&ids)
        .map_err(|e| StorageError::new(StorageCode::SubsessionResultInvalid, e.to_string()))?;
    Ok(format!(
        "\nimage_assets: {ids}\nThese image_collect ids show the reported items. Put them on those items' answer_blocks cards in your own reply; that needs no new Work or delegation."
    ))
}
