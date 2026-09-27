//! Ledger metadata plus delivered public reports, paged from a frozen App watermark.

use std::collections::HashMap;

use chrono::DateTime;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::super::{AppApplication, AppStorageError, GatewayApplicationError, app_error};
use super::contracts::{
    AppProjectDashboardPageQuery, invalid_cursor, invalid_request, source_changed,
};
use super::cursor::{self, HistoryCursor};
use super::project::read_project;
use super::session_links::ProjectSessionLinks;
use crate::public_text::sanitize_public_text;

pub(super) async fn get(
    application: &AppApplication,
    project_id: &str,
    query: AppProjectDashboardPageQuery,
) -> Result<Value, GatewayApplicationError> {
    if !(1..=100).contains(&query.limit) {
        return Err(invalid_request());
    }
    let project = read_project(application, project_id).await?;
    let cursor = query
        .cursor
        .as_deref()
        .map(cursor::decode::<HistoryCursor>)
        .transpose()?;
    if cursor.as_ref().is_some_and(|cursor| {
        cursor.project_id != project.id
            || DateTime::parse_from_rfc3339(&cursor.at).is_err()
            || cursor.id.is_empty()
    }) {
        return Err(invalid_cursor());
    }
    let (ledger_revision, ledger_events, ledger_unavailable) =
        match read_ledger_events(application, &project.id, project.ledger_project_id.clone()).await
        {
            Ok((revision, events)) => (revision, events, false),
            Err(()) => ("unavailable".into(), Vec::new(), true),
        };
    let revision = if ledger_unavailable {
        "unavailable".to_owned()
    } else {
        ledger_revision
    };
    if cursor
        .as_ref()
        .is_some_and(|cursor| cursor.revision != revision)
    {
        return Err(source_changed("Reload the history."));
    }
    let watermark = match cursor.as_ref() {
        Some(cursor) => cursor.rowid,
        None => application
            .storage
            .execute(|db| {
                db.query_row("SELECT COALESCE(MAX(rowid),0) FROM messages", [], |row| {
                    row.get::<_, i64>(0)
                })
                .map(|rowid| u64::try_from(rowid.max(0)).unwrap_or_default())
                .map_err(AppStorageError::sqlite)
            })
            .await
            .map_err(app_error)?,
    };
    let before_at = cursor.as_ref().map_or_else(
        || "9999-12-31T23:59:59.999Z".to_owned(),
        |cursor| cursor.at.clone(),
    );
    let before_id = cursor
        .as_ref()
        .map_or_else(|| "\u{ffff}".to_owned(), |cursor| cursor.id.clone());
    let key = project.id.clone();
    let message_limit = query.limit + 1;
    let message_rows = application
        .storage
        .execute(move |db| {
            read_public_messages(db, &key, watermark, &before_at, &before_id, message_limit)
        })
        .await
        .map_err(app_error)?;
    let mut combined = ledger_events;
    combined.extend(message_rows);
    if let Some(cursor) = &cursor {
        combined.retain(|event| {
            event["at"].as_str().is_some_and(|at| {
                at < cursor.at.as_str()
                    || (at == cursor.at
                        && event["id"]
                            .as_str()
                            .is_some_and(|id| id < cursor.id.as_str()))
            })
        });
    }
    combined.sort_by(compare_history);
    combined.truncate(query.limit + 1);
    let has_more = combined.len() > query.limit;
    combined.truncate(query.limit);
    let next_cursor = if has_more {
        combined.last().and_then(|last| {
            cursor::encode(&HistoryCursor {
                project_id: project.id.clone(),
                revision,
                rowid: watermark,
                at: last["at"].as_str()?.to_owned(),
                id: last["id"].as_str()?.to_owned(),
            })
            .ok()
        })
    } else {
        None
    };
    Ok(json!({
        "status":"ready",
        "ledgerUnavailable":ledger_unavailable,
        "events":combined,
        "nextCursor":next_cursor,
    }))
}

async fn read_ledger_events(
    application: &AppApplication,
    project_id: &str,
    ledger_id: Option<String>,
) -> Result<(String, Vec<Value>), ()> {
    let ledger_id = ledger_id.ok_or(())?;
    let snapshot = application
        .dependencies
        .project_dashboard_ledger
        .snapshot(project_id.to_owned(), ledger_id.clone())
        .await
        .map_err(|_| ())?;
    let history = application
        .dependencies
        .project_dashboard_ledger
        .history(ledger_id.clone())
        .await
        .map_err(|_| ())?;
    let managed = application
        .dependencies
        .project_dashboard_ledger
        .work_history(
            project_id.to_owned(),
            ledger_id,
            snapshot.revision.clone(),
            None,
        )
        .await
        .map_err(|_| ())?;
    let record_titles = snapshot
        .records
        .iter()
        .map(|record| {
            let title = snapshot
                .works
                .iter()
                .find(|work| work.record.id == record.id)
                .and_then(|work| work.managed.as_ref())
                .map_or(record.title.as_str(), |work| work.objective.as_str());
            (
                (record.kind.clone(), record.id.clone()),
                sanitize_public_text(title, ""),
            )
        })
        .collect::<HashMap<_, _>>();
    let mut events = history
        .events
        .iter()
        .filter_map(|event| {
            let title = record_titles.get(&(event.kind.clone(), event.record_id.clone()))?;
            Some(json!({
                "id":format!("ledger:{}", event.id),
                "at":event.at,
                "action":event.action,
                "title":title,
                "source":{"kind":event.kind,"id":event.record_id,"revision":snapshot.revision},
            }))
        })
        .collect::<Vec<_>>();
    let sessions = application
        .list_sessions(Some("project".into()), Some(project_id.to_owned()))
        .await
        .map_err(|_| ())?;
    let key = project_id.to_owned();
    let links = application
        .storage
        .execute(move |db| ProjectSessionLinks::read(db, &key))
        .await
        .map_err(|_| ())?;
    let titles = snapshot
        .works
        .iter()
        .map(|work| {
            (
                work.record.id.as_str(),
                work.managed
                    .as_ref()
                    .map_or(work.record.title.as_str(), |managed| {
                        managed.objective.as_str()
                    }),
            )
        })
        .collect::<HashMap<_, _>>();
    for entry in managed {
        let title = sanitize_public_text(
            titles
                .get(entry.work_id.as_str())
                .copied()
                .unwrap_or(&entry.title),
            "",
        );
        let mut event = json!({
            "id":format!("managed:{}", entry.id),
            "workId":entry.work_id,
            "at":entry.at,
            "action":entry.action,
            "title":title,
            "source":{"kind":"reference","id":entry.id,"revision":entry.revision},
        });
        if let Some(session) = links.resolve(&entry.session_id, &sessions) {
            event["session"] = json!({
                "id":session.id,
                "title":sanitize_public_text(&session.title, ""),
            });
        }
        events.push(event);
    }
    events.sort_by(compare_history);
    Ok((
        format!("{}:{}", snapshot.revision, history.revision),
        events,
    ))
}

fn read_public_messages(
    db: &Connection,
    project_id: &str,
    watermark: u64,
    before_at: &str,
    before_id: &str,
    limit: usize,
) -> Result<Vec<Value>, AppStorageError> {
    let mut statement = db
        .prepare(
            "SELECT m.id,m.chat_id,c.title,m.created_at,m.updated_at,substr(m.text,1,1200),\
             length(m.text),(SELECT count(*) FROM message_attachments a WHERE a.message_id=m.id) \
             FROM chats c JOIN messages m ON m.chat_id=c.id WHERE c.project_id=?1 \
             AND m.rowid<=?2 AND m.role='assistant' AND m.status='delivered' AND \
             NOT (m.safe_error_code IS NOT NULL AND m.safe_error_code IN \
             ('app_turn_queue_failed','goal_completion_incomplete')) \
             AND (m.created_at<?3 OR (m.created_at=?3 AND ('message:'||m.id)<?4)) \
             ORDER BY m.created_at DESC,m.id DESC LIMIT ?5",
        )
        .map_err(AppStorageError::sqlite)?;
    statement
        .query_map(
            params![
                project_id,
                i64::try_from(watermark).unwrap_or(i64::MAX),
                before_at,
                before_id,
                limit
            ],
            |row| {
                let id: String = row.get(0)?;
                let chat_id: String = row.get(1)?;
                let title: String = row.get(2)?;
                let at: String = row.get(3)?;
                let updated_at: String = row.get(4)?;
                let excerpt: String = row.get(5)?;
                let chars: i64 = row.get(6)?;
                let artifacts: i64 = row.get(7)?;
                let locator = serde_json::to_vec(&json!([id, chat_id, updated_at, chars, excerpt]))
                    .map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?;
                Ok(json!({
                    "id":format!("message:{id}"),
                    "at":at,
                    "action":"reported",
                    "title":sanitize_public_text(&title, ""),
                    "session":{"id":chat_id,"title":sanitize_public_text(&title, "")},
                    "artifactCount":artifacts.max(0),
                    "source":{"kind":"message","id":id,"revision":digest(&locator)},
                }))
            },
        )
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)
}

fn compare_history(left: &Value, right: &Value) -> std::cmp::Ordering {
    right["at"]
        .as_str()
        .cmp(&left["at"].as_str())
        .then_with(|| right["id"].as_str().cmp(&left["id"].as_str()))
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
