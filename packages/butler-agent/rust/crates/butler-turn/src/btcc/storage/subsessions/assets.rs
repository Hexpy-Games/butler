//! Successful image receipts (collected or made) become explicit parent input media ids.
use super::*;
use rusqlite::Connection;
pub(super) fn delivery_assets(
    db: &Connection,
    session: &str,
    turn: &str,
    role: crate::btcc::ChildRole,
) -> Result<String, StorageError> {
    let mut query = db.prepare("SELECT CASE tool_name WHEN 'image_collect' THEN json_extract(result_json,'$.id') ELSE json_extract(result_json,'$.image') END FROM btcc_guided_tool_calls c WHERE c.turn_id IN (SELECT ?1 UNION SELECT x.child_turn_id FROM btcc_session_relations r JOIN btcc_steward_results x ON x.relation_id=r.relation_id WHERE r.parent_session_id=?2 AND r.activity_role='worker') AND tool_name IN ('image_collect','generate_image','edit_image') AND json_valid(result_json) AND json_extract(result_json,'$.status')='ok' ORDER BY started_at,rowid").map_err(StorageError::sqlite)?;
    let ids = query
        .query_map([turn, session], |r| r.get::<_, String>(0))
        .map_err(StorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::sqlite)?;
    if ids.is_empty() {
        return Ok(String::new());
    }
    let ids = serde_json::to_string(&ids)
        .map_err(|e| StorageError::new(StorageCode::SubsessionResultInvalid, e.to_string()))?;
    if role == crate::btcc::ChildRole::Worker {
        return Ok(format!(
            "\nimage_assets: {ids}\nThese images go up with your own result automatically."
        ));
    }
    Ok(format!(
        "\nimage_assets: {ids}\nThese ids show the reported items and the pictures made for them. Put them on those items' answer_blocks cards in your own reply, or in image or gallery blocks; that needs no new Work or delegation."
    ))
}
