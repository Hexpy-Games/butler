//! Apply-time re-checks, the stored topic and the one space command to run.
use rusqlite::{Connection, OptionalExtension, params};

use super::super::space::{AppSpaceCommand, AppSpacePosition};
use super::super::storage::AppStorageError;
use super::candidates;
use super::classification::{Classification, Target, normalized};

pub(super) struct Expected {
    pub chat: String,
    pub message_id: String,
    pub node_revision: i64,
    pub classification: Classification,
}

pub(super) struct Plan {
    pub command: AppSpaceCommand,
    pub title: String,
}

/// Stores the topic and picks the move, in one transaction. A late result
/// after the conversation changed (moved, archived, a second message, the
/// setting turned off) plans nothing.
pub(super) fn plan(
    db: &mut Connection,
    expected: &Expected,
    now: &str,
) -> Result<Option<Plan>, AppStorageError> {
    let Some(topic) = expected.classification.topic.as_deref() else {
        return Ok(None);
    };
    let tx = db.savepoint().map_err(AppStorageError::sqlite)?;
    let current = if candidates::enabled(&tx)? {
        candidates::eligible(&tx, &expected.chat)?
    } else {
        None
    };
    let unchanged = current.is_some_and(|source| {
        source.message_id == expected.message_id
            && source.node_revision == expected.node_revision
            && source
                .topic_message_id
                .is_none_or(|id| id == expected.message_id)
    });
    if !unchanged {
        return Ok(None);
    }
    let topic_normalized = normalized(topic);
    tx.execute(
        "INSERT OR IGNORE INTO app_space_topics(session_id,topic,topic_normalized,source_message_id,updated_at) VALUES(?1,?2,?3,?4,?5)",
        params![expected.chat, topic, topic_normalized, expected.message_id, now],
    )
    .map_err(AppStorageError::sqlite)?;
    let plan = choose(&tx, expected, topic, &topic_normalized)?;
    tx.commit().map_err(AppStorageError::sqlite)?;
    Ok(plan)
}

fn choose(
    db: &Connection,
    expected: &Expected,
    topic: &str,
    topic_normalized: &str,
) -> Result<Option<Plan>, AppStorageError> {
    let source_key = format!("s:{}", expected.chat);
    let revision: i64 = db
        .query_row(
            "SELECT revision FROM app_space_state WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .map_err(AppStorageError::sqlite)?;
    let group = match &expected.classification.target {
        Target::Group(key) => match group_title(db, key)? {
            Some(title) => Some((key.clone(), title)),
            None => return Ok(None),
        },
        _ => group_named(db, topic_normalized)?,
    };
    if let Some((target_key, title)) = group {
        return Ok(Some(Plan {
            command: AppSpaceCommand::Move {
                expected_revision: revision,
                source_key,
                target_key: Some(target_key),
                position: AppSpacePosition::Inside,
            },
            title,
        }));
    }
    let peer = match &expected.classification.target {
        Target::Conversation(key) if conversation_eligible(db, key)? => Some(key.clone()),
        Target::Conversation(_) => return Ok(None),
        _ => peer_with_topic(db, &expected.chat, topic_normalized)?,
    };
    Ok(peer.map(|target_key| Plan {
        command: AppSpaceCommand::Group {
            expected_revision: revision,
            source_key,
            target_key,
            title: Some(topic.to_owned()),
        },
        title: topic.to_owned(),
    }))
}

fn group_title(db: &Connection, key: &str) -> Result<Option<String>, AppStorageError> {
    db.query_row(
        "SELECT g.title FROM app_space_nodes n JOIN app_space_groups g ON g.id=n.group_id \
         WHERE n.node_key=?1 AND n.parent_key IS NULL AND g.scope_project_id IS NULL",
        [key],
        |row| row.get(0),
    )
    .optional()
    .map_err(AppStorageError::sqlite)
}

/// Top-level groups outside projects whose title names the topic. Group
/// rows are few, and this runs once per classified conversation.
fn group_named(
    db: &Connection,
    topic_normalized: &str,
) -> Result<Option<(String, String)>, AppStorageError> {
    let mut statement = db
        .prepare(
            "SELECT n.node_key,g.title FROM app_space_groups g JOIN app_space_nodes n ON n.group_id=g.id \
             WHERE g.scope_project_id IS NULL AND n.parent_key IS NULL ORDER BY n.position,n.node_key",
        )
        .map_err(AppStorageError::sqlite)?;
    let mut rows = statement.query([]).map_err(AppStorageError::sqlite)?;
    while let Some(row) = rows.next().map_err(AppStorageError::sqlite)? {
        let title: String = row.get(1).map_err(AppStorageError::sqlite)?;
        if normalized(&title) == topic_normalized {
            return Ok(Some((row.get(0).map_err(AppStorageError::sqlite)?, title)));
        }
    }
    Ok(None)
}

fn conversation_eligible(db: &Connection, key: &str) -> Result<bool, AppStorageError> {
    db.query_row(
        "SELECT 1 FROM app_space_nodes n JOIN chats c ON c.id=n.session_id \
         WHERE n.node_key=?1 AND n.parent_key IS NULL AND n.manual_placement=0 \
         AND c.kind='chat' AND c.archived=0 AND c.project_id IS NULL",
        [key],
        |_| Ok(()),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(AppStorageError::sqlite)
}

/// The oldest automatic top-level conversation already filed under the topic.
fn peer_with_topic(
    db: &Connection,
    chat: &str,
    topic_normalized: &str,
) -> Result<Option<String>, AppStorageError> {
    db.query_row(
        "SELECT n.node_key FROM app_space_topics t \
         JOIN app_space_nodes n ON n.session_id=t.session_id JOIN chats c ON c.id=t.session_id \
         WHERE t.topic_normalized=?1 AND t.session_id!=?2 AND n.parent_key IS NULL \
         AND n.manual_placement=0 AND c.kind='chat' AND c.archived=0 AND c.project_id IS NULL \
         ORDER BY c.created_at,c.id LIMIT 1",
        params![topic_normalized, chat],
        |row| row.get(0),
    )
    .optional()
    .map_err(AppStorageError::sqlite)
}
