//! Read-only canonical conversation projection, called only on a blocking worker.
use crate::host::DateParser;
use butler_memory::cognition::{PatternError, PatternEvent};
use butler_turn::conversation::{ConversationSourceReader, decode_message_scalars};
use chrono::{DateTime, NaiveDate, Utc};
use std::path::Path;

pub(super) fn read_page(
    path: &Path,
    timezone: &DateParser,
    since: DateTime<Utc>,
    offset: usize,
) -> Result<Vec<PatternEvent>, PatternError> {
    let reader = ConversationSourceReader::open(path).map_err(PatternError::port)?;
    let db =
        butler_platform::sqlite::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(PatternError::port)?;
    let ids = page_ids(&db, since, offset)?;
    let messages = ids
        .iter()
        .map(|id| {
            reader
                .read_message(id)
                .map_err(PatternError::port)
                .and_then(|m| m.ok_or(PatternError::NotFound))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut events = Vec::with_capacity(messages.len());
    for message in messages {
        let created_at = DateTime::parse_from_rfc3339(&message.message.created_at)
            .map_err(PatternError::port)?
            .with_timezone(&Utc);
        let (day, minute) = timezone
            .local_day_and_minute(created_at.timestamp_millis())
            .map_err(PatternError::port)?;
        let date = NaiveDate::parse_from_str(&day, "%Y-%m-%d").map_err(PatternError::port)?;
        let weekday = date.format("%a");
        let session = reader
            .read_session(&message.message.session_id)
            .map_err(PatternError::port)?;
        let session_kind = if is_chats(&db, &message.message.session_id)? {
            "chats"
        } else if session.is_some_and(|s| s.project_id.is_some()) {
            "project"
        } else {
            "work"
        };
        let text = decode_message_scalars(&message)
            .iter()
            .map(|s| s.text)
            .collect::<Vec<_>>()
            .join("\n")
            .chars()
            .take(600)
            .collect();
        let kind = if message.message.source_gateway.as_deref() == Some("automation") {
            "schedule_run"
        } else {
            "user_message"
        };
        events.push(PatternEvent {
            id: message.message.id,
            kind: kind.into(),
            session: session_kind.into(),
            created_at,
            at_local: format!("{day} {weekday} {:02}:{:02}", minute / 60, minute % 60),
            text,
            tools: vec![],
        });
    }
    reader.close().map_err(PatternError::port)?;
    Ok(events)
}

fn page_ids(
    db: &rusqlite::Connection,
    since: DateTime<Utc>,
    offset: usize,
) -> Result<Vec<String>, PatternError> {
    let mut statement = db
        .prepare(
            "SELECT id FROM conversation_messages WHERE role='user' \
        AND origin_kind <> 'connector' AND (origin_kind <> 'internal_control' OR source_gateway='automation') \
        AND created_at>=?1 ORDER BY created_at,seq,id LIMIT 200 OFFSET ?2",
        )
        .map_err(PatternError::port)?;
    statement
        .query_map(
            rusqlite::params![
                since.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                offset
            ],
            |r| r.get(0),
        )
        .map_err(PatternError::port)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(PatternError::port)
}
fn is_chats(db: &rusqlite::Connection, session: &str) -> Result<bool, PatternError> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM conversation_bindings WHERE conversation_session_id=?1 \
        AND external_session_id=?2)",
        [session, butler_turn::workspace::CHATS_RUNTIME_SESSION_ID],
        |r| r.get(0),
    )
    .map_err(PatternError::port)
}
