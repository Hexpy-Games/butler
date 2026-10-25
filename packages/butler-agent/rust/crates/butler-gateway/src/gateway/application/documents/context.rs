//! Indexed chat-local document changes, added only to model input.
use super::{records::*, *};
use rusqlite::{OptionalExtension, params};
pub(super) fn seen(db: &Connection, id: &str, input: &Value) -> Result<(), AppStorageError> {
    let rev = positive(input, "rev")?;
    revision(db, id, rev)?;
    let chat = input["chat_id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| invalid("chat_id is required."))?;
    db.execute("INSERT INTO document_seen VALUES(?1,?2,?3) ON CONFLICT(document_id,chat_id) DO UPDATE SET rev=MAX(document_seen.rev,excluded.rev)",params![id,chat,rev]).map_err(AppStorageError::sqlite)?;
    Ok(())
}
pub(in crate::gateway::application) fn pending(
    db: &Connection,
    chat: &str,
) -> Result<Vec<String>, AppStorageError> {
    let mut stmt = db.prepare_cached("SELECT id FROM documents WHERE chat_id=?1 UNION SELECT document_id FROM document_seen WHERE chat_id=?1").map_err(AppStorageError::sqlite)?;
    let ids = stmt
        .query_map([chat], |r| r.get::<_, String>(0))
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    let mut parts = Vec::new();
    for id in ids {
        let seen_rev: i64 = db
            .query_row(
                "SELECT rev FROM document_seen WHERE document_id=?1 AND chat_id=?2",
                params![id, chat],
                |r| r.get(0),
            )
            .optional()
            .map_err(AppStorageError::sqlite)?
            .unwrap_or(0);
        let head = head(db, &id)?;
        let rev = head["rev"].as_i64().unwrap_or(0);
        let user_changed = db.query_row("SELECT 1 FROM document_revisions WHERE document_id=?1 AND rev>?2 AND rev<=?3 AND author='user' LIMIT 1",params![id,seen_rev,rev],|_|Ok(())).optional().map_err(AppStorageError::sqlite)?.is_some();
        if rev <= seen_rev || !user_changed {
            continue;
        }
        let base = if seen_rev > 0 {
            revision(db, &id, seen_rev)?
        } else {
            json!({"body":""})
        };
        let diff = butler_runtime::documents::diff(body(&base), body(&head));
        let title = head["title"].as_str().unwrap_or_default();
        parts.push(if diff.len() > 12 * 1024 {
            format!("The user edited the document \"{title}\" ({id}) substantially since revision {seen_rev}; it is now revision {rev}. Read it with document_read before changing it.")
        } else {
            format!("The user edited the document \"{title}\" ({id}) since revision {seen_rev}; it is now revision {rev}. Changes:\n```diff\n{diff}\n```")
        });
        seen(db, &id, &json!({"chat_id":chat,"rev":rev}))?;
    }
    Ok(parts)
}

/// A retried dispatch keeps the admitted model-only diff even after seen advances.
pub(in crate::gateway::application) fn for_turn(
    db: &Connection,
    chat: &str,
    queued_id: &str,
) -> Result<Vec<String>, AppStorageError> {
    let cached: Option<String> = db
        .query_row(
            "SELECT edits_json FROM session_queued_document_edits WHERE queued_id=?1",
            [queued_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    if let Some(cached) = cached {
        return serde_json::from_str(&cached)
            .map_err(|_| invalid("Invalid document context snapshot."));
    }
    let edits = pending(db, chat)?;
    db.execute(
        "INSERT INTO session_queued_document_edits(queued_id,edits_json) VALUES(?1,?2)",
        params![queued_id, json!(edits).to_string()],
    )
    .map_err(AppStorageError::sqlite)?;
    Ok(edits)
}
