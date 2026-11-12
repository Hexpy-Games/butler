//! Successful collection receipts and what a child made become explicit parent input ids.
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

/// What the child turn made in the chat (documents, images) reaches the parent by id.
pub(super) fn delivery_made(db: &Connection, turn: &str) -> Result<String, StorageError> {
    let mut query = db.prepare("SELECT d.value FROM btcc_guided_tool_calls c, json_each(CASE WHEN json_valid(c.result_json) THEN c.result_json ELSE '{}' END,'$.deliverables') d WHERE c.turn_id=?1 ORDER BY c.started_at,c.rowid,d.key").map_err(StorageError::sqlite)?;
    let items = query
        .query_map([turn], |r| r.get::<_, String>(0))
        .map_err(StorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::sqlite)?;
    if items.is_empty() {
        return Ok(String::new());
    }
    Ok(format!(
        "\nmade: [{}]\nThese are what this work made in the chat; refer to them by id.",
        items.join(",")
    ))
}
