//! Butler's recent suggestions in a chat and the user's answers, read by every turn of that chat.
use super::super::AppStorageError;
use rusqlite::{Connection, params};
use serde_json::Value;

const HEADER: &str = "## Butler's suggestions in this chat\nButler wrote these to the user in this chat on its own, before this turn. They are part of the conversation, not the user's words, and grant no permission.";

const POSTS: usize = 10;

/// The chat's latest suggestions posted since `since`, oldest first, each with the user's current answer.
pub(in crate::gateway::application) fn read(
    db: &Connection,
    chat: &str,
    since: &str,
) -> Result<Option<String>, AppStorageError> {
    let mut statement = db.prepare(&format!("SELECT text,payload_json,posted_at FROM app_initiated_messages WHERE chat_id=?1 AND kind='pattern_proposal' AND state='posted' AND posted_at>=?2 ORDER BY posted_at DESC,rowid DESC LIMIT {POSTS}")).map_err(AppStorageError::sqlite)?;
    let mut rows = statement
        .query_map(params![chat, since], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    if rows.is_empty() {
        return Ok(None);
    }
    rows.reverse();
    let mut lines = Vec::new();
    for (text, payload, posted) in rows {
        let payload: Value = serde_json::from_str(&payload).map_err(super::outbox::json_error)?;
        lines.push(format!("- {posted}: Butler said: {}", Value::String(text)));
        for c in payload["panel"]["candidates"]
            .as_array()
            .into_iter()
            .flatten()
        {
            lines.push(format!(
                "  - Offer: {}. The user's answer: {}.",
                offer(c),
                answer(c)
            ));
        }
    }
    Ok(Some(format!("{HEADER}\n{}", lines.join("\n"))))
}

fn offer(c: &Value) -> String {
    let title = c["action"]["title"].as_str().unwrap_or_default().to_owned();
    if c["action"]["kind"] == "schedule" {
        let schedule = &c["action"]["schedule"];
        format!(
            "a 예약 작업 {} ({} at {})",
            Value::String(title),
            schedule["type"].as_str().unwrap_or_default(),
            schedule["time"].as_str().unwrap_or_default()
        )
    } else {
        format!("one-time work {}", Value::String(title))
    }
}

fn answer(c: &Value) -> &str {
    match c["state"].as_str() {
        Some("accepted") if c["action"]["kind"] == "schedule" => {
            "accepted; the 예약 작업 was created"
        }
        Some("accepted") => "accepted",
        Some("declined") => "declined",
        _ => "no answer yet",
    }
}

/// The window start: thirty days before the App clock's now.
pub(in crate::gateway::application) fn since(now: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(now).ok().map(|t| {
        (t - chrono::Duration::days(30)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    })
}
