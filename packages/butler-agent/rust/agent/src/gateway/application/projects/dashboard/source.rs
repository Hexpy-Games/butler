//! Project-owned public source reads and UTF-16 document paging.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::super::{AppApplication, AppStorageError, GatewayApplicationError, app_error};
use super::contracts::{
    AppProjectDashboardLedgerError, AppProjectDashboardSourceQuery, invalid_cursor, source_changed,
};
use super::cursor::{self, RevisionOffsetCursor};
use super::project::{DashboardProject, read_project};
use crate::json::Utf16Slice;
use crate::public_text::sanitize_public_text;

const SOURCE_PAGE_UNITS: usize = 24_000;

pub(super) async fn get(
    application: &AppApplication,
    project_id: &str,
    query: AppProjectDashboardSourceQuery,
) -> Result<Value, GatewayApplicationError> {
    let project = read_project(application, project_id).await?;
    match query.kind.as_str() {
        "artifact" => {
            let id = query.id.clone();
            let project_key = project.id.clone();
            let artifact = application
                .storage
                .execute(move |db| super::artifacts::read_artifact(db, &project_key, &id))
                .await
                .map_err(app_error)?;
            let Some(artifact) = artifact else {
                return Err(source_unavailable());
            };
            if query.revision != artifact.revision {
                return Err(source_changed("Source changed. Reload it."));
            }
            let title = sanitize_public_text(&artifact.file.safe_name, "");
            let safe_path_label = title.clone();
            let updated_at = artifact.file.created_at.clone();
            let artifact_view = super::artifacts::artifact_json(&artifact);
            return Ok(json!({
                "id":artifact.id,
                "project_id":project.id,
                "revision":artifact.revision,
                "kind":"report",
                "document_type":"artifact",
                "title":title,
                "safe_path_label":safe_path_label,
                "markdown":"",
                "updated_at":updated_at,
                "artifact":artifact_view,
            }));
        }
        "message" => {
            let id = query.id.clone();
            let project_key = project.id.clone();
            let expected = query.revision.clone();
            let report = application
                .storage
                .execute(move |db| read_report(db, &project_key, &id, &expected))
                .await
                .map_err(source_error)?;
            return source_page(SourcePageInput {
                project: &project,
                butler_data: &application.butler_data.to_string_lossy(),
                id: &query.id,
                kind: &query.kind,
                document_type: &query.kind,
                revision: report.revision,
                title: report.title,
                body: report.body,
                status: "delivered".to_owned(),
                updated_at: report.updated_at,
                encoded_cursor: query.cursor.as_deref(),
            });
        }
        "reference" => {
            let Some(ledger_id) = project.ledger_project_id.clone() else {
                return Err(source_unavailable());
            };
            let (work_id, _) = query.id.split_once('|').unwrap_or((&query.id, ""));
            let Ok(snapshot) = application
                .dependencies
                .project_dashboard_ledger
                .snapshot(project.id.clone(), ledger_id.clone())
                .await
            else {
                return Err(source_unavailable());
            };
            let Ok(entries) = application
                .dependencies
                .project_dashboard_ledger
                .work_history(
                    project.id.clone(),
                    ledger_id,
                    snapshot.revision,
                    Some(work_id.to_owned()),
                )
                .await
            else {
                return Err(source_unavailable());
            };
            let Some(entry) = entries.into_iter().find(|entry| entry.id == query.id) else {
                return Err(source_unavailable());
            };
            if entry.revision != query.revision {
                return Err(source_changed("Source changed. Reload it."));
            }
            return source_page(SourcePageInput {
                project: &project,
                butler_data: &application.butler_data.to_string_lossy(),
                id: &query.id,
                kind: &query.kind,
                document_type: &query.kind,
                revision: entry.revision,
                title: entry.title,
                body: format!("```json\n{}\n```", entry.body),
                status: entry.status,
                updated_at: entry.at,
                encoded_cursor: query.cursor.as_deref(),
            });
        }
        _ => {}
    }

    let Some(ledger_id) = project.ledger_project_id.clone() else {
        return Err(source_unavailable());
    };
    let Ok(snapshot) = application
        .dependencies
        .project_dashboard_ledger
        .snapshot(project.id.clone(), ledger_id.clone())
        .await
    else {
        return Err(source_unavailable());
    };
    let source = match application
        .dependencies
        .project_dashboard_ledger
        .source(
            project.id.clone(),
            ledger_id,
            query.kind.clone(),
            query.id.clone(),
            query.revision.clone(),
        )
        .await
    {
        Ok(source) => source,
        Err(error) => return Err(ledger_source_error(error)),
    };
    if query.revision != snapshot.revision && query.revision != source.revision {
        return Err(source_changed("Source changed. Reload it."));
    }
    source_page(SourcePageInput {
        project: &project,
        butler_data: &application.butler_data.to_string_lossy(),
        id: &query.id,
        kind: &query.kind,
        document_type: &source.document_type,
        revision: source.revision,
        title: source.title,
        body: source.body,
        status: source.status,
        updated_at: source.updated_at,
        encoded_cursor: query.cursor.as_deref(),
    })
}

struct Report {
    title: String,
    body: String,
    revision: String,
    updated_at: String,
}

fn read_report(
    db: &Connection,
    project_id: &str,
    message_id: &str,
    expected: &str,
) -> Result<Report, AppStorageError> {
    let row = db
        .query_row(
            "SELECT m.id,m.chat_id,c.title,m.text,m.updated_at,length(m.text),substr(m.text,1,1200) \
             FROM chats c JOIN messages m ON m.chat_id=c.id WHERE c.project_id=?1 AND m.id=?2 \
             AND m.role='assistant' AND m.status='delivered' AND \
             NOT (m.safe_error_code IS NOT NULL AND m.safe_error_code IN \
             ('app_turn_queue_failed','goal_completion_incomplete'))",
            params![project_id, message_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, String>(6)?,
                ))
            },
        )
        .optional()
        .map_err(AppStorageError::sqlite)?
        .ok_or_else(|| AppStorageError::new("source_unavailable", "Source unavailable."))?;
    let revision = digest(row.3.as_bytes());
    let locator = serde_json::to_vec(&json!([row.0, row.1, row.4, row.5, row.6]))
        .map_err(|error| AppStorageError::new("app_json_failed", error.to_string()))?;
    if expected != digest(&locator) && expected != revision {
        return Err(AppStorageError::new(
            "source_changed",
            "Source changed. Reload it.",
        ));
    }
    Ok(Report {
        title: row.2,
        body: row.3,
        revision,
        updated_at: row.4,
    })
}

struct SourcePageInput<'a> {
    project: &'a DashboardProject,
    butler_data: &'a str,
    id: &'a str,
    kind: &'a str,
    document_type: &'a str,
    revision: String,
    title: String,
    body: String,
    status: String,
    updated_at: String,
    encoded_cursor: Option<&'a str>,
}

fn source_page(input: SourcePageInput<'_>) -> Result<Value, GatewayApplicationError> {
    let SourcePageInput {
        project,
        butler_data,
        id,
        kind,
        document_type,
        revision,
        title,
        body,
        status,
        updated_at,
        encoded_cursor,
    } = input;
    let body = safe_document(&body, &[butler_data, &project.workspace_path]);
    let cursor = encoded_cursor
        .map(cursor::decode::<RevisionOffsetCursor>)
        .transpose()?
        .unwrap_or_else(|| RevisionOffsetCursor {
            revision: revision.clone(),
            offset: 0,
        });
    if cursor.revision != revision {
        return Err(source_changed("Source changed. Reload it."));
    }
    let length = body.encode_utf16().count();
    if cursor.offset > length {
        return Err(invalid_cursor());
    }
    let end = cursor.offset.saturating_add(SOURCE_PAGE_UNITS).min(length);
    let markdown = Utf16Slice::new(&body, cursor.offset, end)
        .utf8_lossy()
        .into_owned();
    let next_cursor = (end < length)
        .then(|| {
            cursor::encode(&RevisionOffsetCursor {
                revision: revision.clone(),
                offset: end,
            })
            .ok()
        })
        .flatten();
    Ok(json!({
        "id":id,
        "project_id":project.id,
        "revision":revision,
        "kind":match kind {"spec" => "spec", "report" | "message" => "report", _ => "plan"},
        "document_type":document_type,
        "title":sanitize_public_text(&title, ""),
        "status":status,
        "safe_path_label":sanitize_public_text(&title, ""),
        "markdown":markdown,
        "updated_at":updated_at,
        "truncated":end < length,
        "nextCursor":next_cursor,
    }))
}

fn safe_document(markdown: &str, roots: &[&str]) -> String {
    let mut text = markdown.to_owned();
    for root in roots.iter().filter(|root| root.len() > 1) {
        text = text.replace(root, "[local]");
    }
    text.split('\n')
        .map(|line| {
            let safe = sanitize_public_text(line, "");
            if safe == line.trim() {
                line.to_owned()
            } else {
                safe
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn source_error(error: AppStorageError) -> GatewayApplicationError {
    match error.code() {
        "source_changed" => source_changed("Source changed. Reload it."),
        "source_unavailable" => GatewayApplicationError::Public {
            status: 404,
            code: "source_unavailable".into(),
            message: "Source unavailable.".into(),
        },
        _ => app_error(error),
    }
}

fn ledger_source_error(error: AppProjectDashboardLedgerError) -> GatewayApplicationError {
    match error {
        AppProjectDashboardLedgerError::Changed => source_changed("Source changed. Reload it."),
        AppProjectDashboardLedgerError::Unavailable => GatewayApplicationError::Public {
            status: 404,
            code: "source_unavailable".into(),
            message: "Source unavailable.".into(),
        },
        AppProjectDashboardLedgerError::Internal => GatewayApplicationError::Internal,
    }
}

fn source_unavailable() -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 404,
        code: "source_unavailable".into(),
        message: "Source unavailable.".into(),
    }
}
