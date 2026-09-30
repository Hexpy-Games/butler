//! Change-driven monitor projection: reads never hydrate historical messages.
//! Rebuild compact references and artifact labels only after their sources change.
use super::super::{message_visibility::owner_visible, storage::AppStorageError};
use super::{AppWorkStatusConversationFact, conversation::safe_conversation_label};
use rusqlite::{Connection, OptionalExtension, params};
use std::{cmp::Reverse, collections::HashSet, sync::LazyLock};

pub(crate) fn refresh(db: &Connection) -> Result<(), AppStorageError> {
    let dirty: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM app_work_monitor_dirty)",
            [],
            |row| row.get(0),
        )
        .map_err(AppStorageError::sqlite)?;
    if !dirty {
        return Ok(());
    }
    // Source rows and their invalidation are read/settled under the same write
    // reservation. A concurrent writer cannot have its dirty mark erased.
    let tx = rusqlite::Transaction::new_unchecked(db, rusqlite::TransactionBehavior::Immediate)
        .map_err(AppStorageError::sqlite)?;
    refresh_dirty(&tx)?;
    tx.commit().map_err(AppStorageError::sqlite)
}

fn refresh_dirty(db: &Connection) -> Result<(), AppStorageError> {
    let chats = db
        .prepare_cached("SELECT chat_id FROM app_work_monitor_dirty")
        .map_err(AppStorageError::sqlite)?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    for chat in chats {
        let exists: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM chats WHERE id=?1)",
                [&chat],
                |row| row.get(0),
            )
            .map_err(AppStorageError::sqlite)?;
        if !exists {
            db.execute("DELETE FROM app_work_monitor WHERE chat_id=?1", [&chat])
                .map_err(AppStorageError::sqlite)?;
            db.execute(
                "DELETE FROM app_work_monitor_dirty WHERE chat_id=?1",
                [&chat],
            )
            .map_err(AppStorageError::sqlite)?;
            continue;
        }
        let fact = project(db, &chat)?;
        db.execute("INSERT INTO app_work_monitor(chat_id,runtime_session_id,summary,artifacts_json) VALUES(?1,?2,?3,?4) \
          ON CONFLICT(chat_id) DO UPDATE SET runtime_session_id=excluded.runtime_session_id,summary=excluded.summary,artifacts_json=excluded.artifacts_json",
          params![chat,super::super::app_session_hint(&chat), fact.latest_report_summary, serde_json::to_string(&fact.recent_artifacts).map_err(json_error)?])
          .map_err(AppStorageError::sqlite)?;
        db.execute(
            "DELETE FROM app_work_monitor_dirty WHERE chat_id=?1",
            [chat],
        )
        .map_err(AppStorageError::sqlite)?;
    }
    Ok(())
}

pub(super) fn read(
    db: &Connection,
    session: &str,
) -> Result<AppWorkStatusConversationFact, AppStorageError> {
    let fact = db.query_row(
        "SELECT m.summary,m.artifacts_json FROM app_work_monitor m JOIN chats c ON c.id=m.chat_id \
         WHERE c.id IN (SELECT id FROM chats WHERE id=?1 UNION \
           SELECT chat_id FROM app_work_monitor WHERE runtime_session_id=?1) \
         AND c.archived=0 AND NOT EXISTS(SELECT 1 \
         FROM app_session_branches b WHERE b.target_session_id=c.id AND b.state='prepared') \
         ORDER BY c.pinned DESC,c.updated_at DESC,c.created_at DESC LIMIT 1",
        [session], |row| Ok((row.get::<_, Option<String>>(0)?,row.get::<_, String>(1)?)))
        .optional().map_err(AppStorageError::sqlite)?;
    let Some((latest_report_summary, raw)) = fact else {
        return Ok(AppWorkStatusConversationFact::default());
    };
    Ok(AppWorkStatusConversationFact {
        latest_report_summary,
        recent_artifacts: serde_json::from_str(&raw).map_err(json_error)?,
    })
}

fn project(db: &Connection, chat: &str) -> Result<AppWorkStatusConversationFact, AppStorageError> {
    let mut refs = references(db, chat)?;
    let artifacts = artifact_inputs(db, chat)?;
    for (_, ids) in &artifacts {
        refs.extend(ids.iter().cloned());
    }
    let mut refs = refs
        .into_iter()
        .filter(|id| !id.is_empty())
        .collect::<Vec<_>>();
    refs.sort_unstable_by(|a, b| {
        Reverse(a.len())
            .cmp(&Reverse(b.len()))
            .then_with(|| a.cmp(b))
    });
    // Rust's trim whitespace, so whitespace-only newer deliveries do not hide the last report.
    static WHITESPACE: LazyLock<String> = LazyLock::new(|| {
        (0..=0x3000)
            .filter_map(char::from_u32)
            .filter(|c| c.is_whitespace())
            .collect()
    });
    let report = db.query_row(
        "SELECT text FROM messages WHERE chat_id=?1 AND role='assistant' AND status='delivered' \
         AND NOT(safe_error_code IS NOT NULL AND safe_error_code IN ('app_turn_queue_failed','goal_completion_incomplete')) \
         AND length(trim(text,?2))>0 ORDER BY rowid DESC LIMIT 1", params![chat, WHITESPACE.as_str()], |row| row.get::<_, String>(0))
        .optional().map_err(AppStorageError::sqlite)?;
    let mut seen = HashSet::new();
    let mut recent_artifacts = std::collections::VecDeque::new();
    for (title, _) in artifacts {
        let label = safe_conversation_label(&title, &refs, "Artifact");
        if seen.insert(label.clone()) {
            recent_artifacts.push_back(label);
            if recent_artifacts.len() > 3 {
                recent_artifacts.pop_front();
            }
        }
    }
    Ok(AppWorkStatusConversationFact {
        latest_report_summary: report
            .map(|text| safe_conversation_label(&text, &refs, "A recent report is available.")),
        recent_artifacts: recent_artifacts.into(),
    })
}

fn references(db: &Connection, chat: &str) -> Result<HashSet<String>, AppStorageError> {
    let mut refs = HashSet::from([chat.to_owned(), super::super::app_session_hint(chat)]);
    let sql = concat!(
        "SELECT m.id,m.chat_id,m.turn_id,m.conversation_session_id, \
       m.conversation_turn_id,m.conversation_message_id FROM messages m WHERE m.chat_id=?1 \
       AND NOT(m.role='assistant' AND m.safe_error_code IS NOT NULL AND \
       m.safe_error_code IN ('app_turn_queue_failed','goal_completion_incomplete')) AND ",
        owner_visible!()
    );
    let mut statement = db.prepare_cached(sql).map_err(AppStorageError::sqlite)?;
    let mut rows = statement.query([chat]).map_err(AppStorageError::sqlite)?;
    while let Some(row) = rows.next().map_err(AppStorageError::sqlite)? {
        for col in 0..6 {
            if let Some(id) = row
                .get::<_, Option<String>>(col)
                .map_err(AppStorageError::sqlite)?
            {
                refs.insert(id);
            }
        }
    }
    Ok(refs)
}

fn artifact_inputs(
    db: &Connection,
    chat: &str,
) -> Result<Vec<(String, Vec<String>)>, AppStorageError> {
    let mut statement = db.prepare_cached(
        "SELECT f.safe_name,f.id,m.id,m.turn_id FROM messages m \
         JOIN message_attachments a ON a.message_id=m.id JOIN message_files f ON f.id=a.file_id \
         WHERE m.chat_id=?1 AND m.role='assistant' AND m.status='delivered' \
         AND NOT(m.safe_error_code IS NOT NULL AND m.safe_error_code IN ('app_turn_queue_failed','goal_completion_incomplete')) \
         ORDER BY m.rowid,a.position").map_err(AppStorageError::sqlite)?;
    statement
        .query_map([chat], |row| {
            let file: String = row.get(1)?;
            let mut ids = vec![
                format!("artifact-{file}"),
                file,
                row.get(2)?,
                chat.to_owned(),
            ];
            if let Some(turn) = row.get::<_, Option<String>>(3)? {
                ids.push(turn);
            }
            Ok((row.get(0)?, ids))
        })
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)
}

fn json_error(error: serde_json::Error) -> AppStorageError {
    AppStorageError::new(
        super::super::storage::AppStorageCode::AppProjectionJsonInvalid,
        error.to_string(),
    )
    .with_source(error)
}
