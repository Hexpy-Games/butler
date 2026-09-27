//! App-owned user observations and visible report inputs.

use rusqlite::{Connection, params};
use sha2::{Digest, Sha256};

use super::super::super::super::AppStorageError;
use super::types::{Fact, Followup, FollowupReference};
use crate::{
    context::prefix_utf16,
    gateway::{MessageContent, MessageContentPart},
    public_text::sanitize_public_text,
};

pub(super) fn add_followups(fact: &mut Fact, followups: Vec<Followup>) {
    if followups.is_empty() {
        return;
    }
    match fact {
        Fact::Work(fact) => fact.linked_user_followups = Some(followups),
        Fact::Document(fact) => fact.linked_user_followups = Some(followups),
        Fact::Report(fact) => fact.linked_user_followups = Some(followups),
    }
}

pub(super) struct ReportRow {
    pub(super) id: String,
    pub(super) chat_id: String,
    pub(super) title: String,
    pub(super) excerpt: String,
    pub(super) chars: i64,
    pub(super) updated_at: String,
    pub(super) locator_revision: String,
}

pub(super) fn read_reports(
    db: &Connection,
    project_id: &str,
) -> Result<Vec<ReportRow>, AppStorageError> {
    let mut statement = db
        .prepare(
            "SELECT m.id,m.chat_id,c.title,substr(m.text,1,1200),length(m.text),m.updated_at \
             FROM chats c JOIN messages m ON m.chat_id=c.id WHERE c.project_id=?1 \
             AND m.role='assistant' AND m.status='delivered' AND NOT \
             (m.safe_error_code IS NOT NULL AND m.safe_error_code IN \
             ('app_turn_queue_failed','goal_completion_incomplete')) \
             ORDER BY m.created_at DESC,m.id DESC LIMIT 7",
        )
        .map_err(AppStorageError::sqlite)?;
    statement
        .query_map([project_id], |row| {
            let id: String = row.get(0)?;
            let chat_id: String = row.get(1)?;
            let title: String = row.get(2)?;
            let excerpt: String = row.get(3)?;
            let chars: i64 = row.get(4)?;
            let updated_at: String = row.get(5)?;
            let locator = serde_json::to_vec(&(&id, &chat_id, &updated_at, chars, &excerpt))
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
            let locator_revision = format!("{:x}", Sha256::digest(locator));
            Ok(ReportRow {
                id,
                chat_id,
                title,
                excerpt,
                chars,
                updated_at,
                locator_revision,
            })
        })
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)
}

pub(super) fn read_followups(
    db: &Connection,
    project_id: &str,
    source_id: &str,
) -> Result<Vec<Followup>, AppStorageError> {
    let mut statement = db
        .prepare(
            "SELECT m.id,substr(m.text,1,1200),length(m.text),m.content_parts_json,m.created_at \
             FROM chats c JOIN messages m ON m.chat_id=c.id WHERE c.project_id=?1 \
             AND m.role='user' AND m.status='sent' AND EXISTS ( \
               SELECT 1 FROM json_each(CASE WHEN json_valid(m.content_parts_json) \
                 THEN m.content_parts_json ELSE '{\"parts\":[]}' END,'$.parts') ref \
               WHERE ref.type='object' AND json_extract(ref.value,'$.type')='project_source_ref' \
                 AND json_extract(ref.value,'$.projectId')=?1 \
                 AND json_extract(ref.value,'$.source.kind')||':'||json_extract(ref.value,'$.source.id')=?2) \
             ORDER BY m.created_at DESC,m.id DESC LIMIT 3",
        )
        .map_err(AppStorageError::sqlite)?;
    let mut rows = statement
        .query_map(params![project_id, source_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    rows.reverse();
    Ok(rows
        .into_iter()
        .filter_map(|(message_id, excerpt, chars, raw, reported_at)| {
            let content: MessageContent = serde_json::from_str(raw.as_deref()?).ok()?;
            if content.version != 1 {
                return None;
            }
            let matching = content
                .parts
                .iter()
                .filter_map(|part| match part {
                    MessageContentPart::ProjectSourceRef {
                        project_id: ref_project,
                        source,
                        topic,
                        ..
                    } if ref_project == project_id
                        && format!("{}:{}", source.kind, source.id) == source_id =>
                    {
                        Some(FollowupReference {
                            revision: source.revision.clone(),
                            topic: topic.as_deref().map(|text| sanitize_public_text(text, "")),
                        })
                    }
                    _ => None,
                })
                .collect::<Vec<_>>();
            if matching.is_empty() {
                return None;
            }
            let text_parts = content
                .parts
                .iter()
                .filter_map(|part| match part {
                    MessageContentPart::Text { text, .. } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>();
            let text = text_parts.concat();
            let (observation, truncated) = if text_parts.is_empty() {
                (excerpt, chars > 1_200)
            } else {
                (
                    prefix_utf16(&text, 1_200).to_owned(),
                    text.encode_utf16().count() > 1_200,
                )
            };
            Some(Followup {
                message_id,
                reported_at,
                observation: sanitize_public_text(&observation, ""),
                excerpt_truncated: truncated,
                references: matching,
            })
        })
        .collect())
}
