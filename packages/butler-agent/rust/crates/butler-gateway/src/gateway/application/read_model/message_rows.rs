//! Exact active-stream rows; terminal messages keep their full progress projection.
use super::*;

pub(super) fn read(row: &Row<'_>) -> rusqlite::Result<MessageRow> {
    Ok(MessageRow {
        cursor: row.get(0)?,
        id: row.get(1)?,
        chat_id: row.get(2)?,
        turn_id: row.get(3)?,
        conversation_session_id: row.get(4)?,
        conversation_turn_id: row.get(5)?,
        conversation_message_id: row.get(6)?,
        role: row.get(7)?,
        text: row.get(8)?,
        content_parts_json: row.get(9)?,
        status: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
        safe_error_code: row.get(13)?,
        retryable: row.get(14)?,
        plan_json: row.get(15)?,
    })
}

pub(in crate::gateway::application) fn streaming_message(
    db: &Connection,
    chat: &str,
    turn: &str,
    id: &str,
) -> Result<Option<MessageRecord>, AppStorageError> {
    // The active turn cannot have terminal work/activity decorations. Read its
    // exact row and every attachment/change field without hydrating unrelated
    // messages or replaying progress which decorate() would leave unused.
    let sql = concat!(
        "SELECT rowid,id,chat_id,turn_id,conversation_session_id,conversation_turn_id,",
        "conversation_message_id,role,text,content_parts_json,status,created_at,updated_at,",
        "safe_error_code,retryable,plan_json FROM messages m ",
        "WHERE id=?1 AND chat_id=?2 AND turn_id=?3 AND role='assistant' AND status='streaming' ",
        "AND EXISTS(SELECT 1 FROM turns WHERE id=?3 AND state IN ",
        "('accepted','thinking','streaming','waiting_for_tool','retrying','cancelling')) ",
        "AND NOT(safe_error_code IS NOT NULL AND ",
        "safe_error_code IN ('app_turn_queue_failed','goal_completion_incomplete')) AND ",
        owner_visible!()
    );
    let row = db
        .query_row_cached(sql, params![id, chat, turn], read)
        .optional()
        .map_err(AppStorageError::sqlite)?;
    row.map(|row| {
        let ids = vec![row.id.clone()];
        message(row, &attachments(db, &ids)?, &changed_files(db, &ids)?)
    })
    .transpose()
}

/// Project one accepted row by its primary key, with the same visibility and decoration.
pub(in crate::gateway::application) fn exact_message(
    db: &Connection,
    chat_id: &str,
    id: &str,
) -> Result<Option<MessageRecord>, AppStorageError> {
    let query = format!(
        "SELECT rowid,id,chat_id,turn_id,conversation_session_id,conversation_turn_id,conversation_message_id,role,text,content_parts_json,status,created_at,updated_at,safe_error_code,retryable,plan_json FROM messages m WHERE id=?1 AND chat_id=?2 AND {}",
        owner_visible!()
    );
    let row = db
        .query_row_cached(&query, params![id, chat_id], read)
        .optional()
        .map_err(AppStorageError::sqlite)?;
    let Some(row) = row else {
        return Ok(None);
    };
    let ids = vec![id.to_owned()];
    let attachments = attachments(db, &ids)?;
    let changed = changed_files(db, &ids)?;
    let mut messages = vec![message(row, &attachments, &changed)?];
    let progress = progress_for_messages(db, &messages)?;
    super::super::message_projection::decorate(db, &mut messages, &progress)?;
    Ok(messages.pop())
}
