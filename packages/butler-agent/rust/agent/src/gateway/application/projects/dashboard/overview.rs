use chrono::{DateTime, Duration, Utc};
use rusqlite::{Connection, params};
use serde_json::{Value, json};

use super::super::{AppApplication, AppStorageError, GatewayApplicationError, app_error};
use super::contracts::{AppProjectDashboardLedgerRecord, AppProjectDashboardWork, unavailable};
use super::project::{pins, project_summary, read_project};
use super::session_links::ProjectSessionLinks;
use crate::gateway::AppSessionSummary;
use crate::public_text::sanitize_public_text;

pub(super) async fn get(
    application: &AppApplication,
    project_id: &str,
) -> Result<Value, GatewayApplicationError> {
    let project = read_project(application, project_id).await?;
    let sessions = application
        .list_sessions(Some("project".into()), Some(project_id.to_owned()))
        .await?;
    let now = application.dependencies.identity_clock.now_iso();
    let metrics = metrics(application, project_id, &now, sessions.len()).await?;
    let snapshot = match project.ledger_project_id.as_ref() {
        Some(ledger_id) => application
            .dependencies
            .project_dashboard_ledger
            .snapshot(project.id.clone(), ledger_id.clone())
            .await
            .ok(),
        None => None,
    };
    let overview = match (&project.ledger_project_id, &snapshot) {
        (None, _) => unavailable("unbound"),
        (Some(_), None) => unavailable("source_unavailable"),
        (Some(_), Some(snapshot)) => {
            let key = project.id.clone();
            let links = application
                .storage
                .execute(move |db| ProjectSessionLinks::read(db, &key))
                .await
                .map_err(app_error)?;
            facts(
                &snapshot.revision,
                &snapshot.observed_at,
                &snapshot.records,
                &snapshot.works,
                &sessions,
                &links,
            )
        }
    };
    let records = snapshot
        .as_ref()
        .map(|snapshot| snapshot.records.as_slice())
        .unwrap_or_default();
    let dashboard_pins = pins(&project).map_err(app_error)?;
    let briefing = super::briefing::read(application, &project.id).await?;
    let view = json!({
        "project": project_summary(&project, sessions),
        "description": project.description,
        "preferences": {"revision": project.preferences_revision, "pinnedSourceRefs": dashboard_pins},
        "overview": overview,
        "briefing": briefing,
        "stats": {
            "active_sessions": metrics.active_sessions,
            "archived_sessions": metrics.archived_sessions,
            "recent_messages_7d": metrics.recent_messages_7d,
            "recent_messages_30d": metrics.recent_messages_30d,
            "specs": records.iter().filter(|record| record.kind == "spec").count(),
            "plans": records.iter().filter(|record| record.kind == "plan").count(),
        },
        "activity": {"days": metrics.days},
        "documents": [],
        "generated_at": now,
    });
    Ok(view)
}

pub(super) fn facts(
    revision: &str,
    observed_at: &str,
    records: &[AppProjectDashboardLedgerRecord],
    works: &[AppProjectDashboardWork],
    sessions: &[AppSessionSummary],
    links: &ProjectSessionLinks,
) -> Value {
    let mut progress = json!({
        "completed": 0_u64,
        "open": 0_u64,
        "blocked": 0_u64,
        "abandoned": 0_u64,
        "unknown": 0_u64,
    });
    let mut cards = works
        .iter()
        .map(|work| {
            let status = work_status(work);
            if let Some(value) = progress.get(status.as_str()).and_then(Value::as_u64) {
                progress[status.as_str()] = json!(value + 1);
            }
            let session = work
                .managed
                .as_ref()
                .and_then(|managed| links.resolve(&managed.session_id, sessions));
            let disposition = work
                .managed
                .as_ref()
                .and_then(|managed| managed.latest_disposition.as_ref());
            let checkpoint = work
                .managed
                .as_ref()
                .and_then(|managed| managed.latest_checkpoint.as_ref());
            let disposition_is_latest = disposition.is_some_and(|disposition| {
                checkpoint.is_none_or(|checkpoint| disposition.created_at >= checkpoint.created_at)
            });
            let remaining = disposition_is_latest
                && disposition.is_some_and(|item| !item.remaining_actions.is_empty());
            let running = session.is_some_and(session_running);
            let rank = if status == "blocked" || remaining {
                0
            } else if work.managed.is_some() && running {
                1
            } else {
                2
            };
            let tasks = records
                .iter()
                .filter(|record| {
                    record.kind == "task"
                        && record.parent_id.as_deref() == Some(work.record.id.as_str())
                })
                .collect::<Vec<_>>();
            let task_progress = (!tasks.is_empty()).then(|| {
                json!({
                    "done": tasks.iter().filter(|task| task.status == "done").count(),
                    "total": tasks.len(),
                })
            });
            let card = json!({
                "id": work.record.id,
                "title": sanitize_public_text(work.managed.as_ref().map_or(&work.record.title, |managed| &managed.objective), ""),
                "revision": work.revision,
                "authorityKind": if work.managed.is_some() {"managed_work"} else {"ledger_record"},
                "executionStatus": status,
                "ledgerStatus": work.record.status,
                "updatedAt": work.record.updated_at,
                "priority": work.record.priority,
                "taskProgress": task_progress,
            });
            (rank, work.record.priority, work.record.updated_at.as_str(), work.record.id.as_str(), card)
        })
        .collect::<Vec<_>>();
    cards.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| a.1.total_cmp(&b.1))
            .then_with(|| b.2.cmp(a.2))
            .then_with(|| a.3.cmp(b.3))
    });
    let mut remaining = cards
        .into_iter()
        .filter(|(_, _, _, _, card)| {
            matches!(card["executionStatus"].as_str(), Some("open" | "blocked"))
        })
        .map(|(_, _, _, _, card)| card)
        .collect::<Vec<_>>();
    let remaining_count = remaining.len();
    remaining.truncate(5);
    json!({
        "status":"ready",
        "sourceRevision":revision,
        "observedAt":observed_at,
        "totalWorks":works.len(),
        "progress":progress,
        "remaining":remaining,
        "remainingCount":remaining_count,
    })
}

pub(super) fn work_status(work: &AppProjectDashboardWork) -> String {
    if work.availability != "ready" {
        return "unknown".into();
    }
    if let Some(managed) = &work.managed {
        return match managed.status.as_str() {
            "open" | "blocked" | "completed" | "abandoned" | "unknown" => managed.status.clone(),
            _ => "unknown".into(),
        };
    }
    match work.record.status.as_str() {
        "done" => "completed".into(),
        "cancelled" => "abandoned".into(),
        "blocked" => "blocked".into(),
        "proposed" | "scoped" | "specified" | "in_progress" | "review" => "open".into(),
        _ => "unknown".into(),
    }
}

pub(super) fn session_running(session: &AppSessionSummary) -> bool {
    matches!(
        session.active_turn_state.as_deref(),
        Some("accepted" | "thinking" | "streaming" | "waiting_for_tool" | "retrying")
    )
}

struct ProjectMetrics {
    active_sessions: usize,
    archived_sessions: usize,
    recent_messages_7d: usize,
    recent_messages_30d: usize,
    days: Vec<Value>,
}

async fn metrics(
    application: &AppApplication,
    project_id: &str,
    now: &str,
    active_sessions: usize,
) -> Result<ProjectMetrics, GatewayApplicationError> {
    let date = DateTime::parse_from_rfc3339(now)
        .map_err(|_| GatewayApplicationError::Internal)?
        .with_timezone(&Utc)
        .date_naive();
    let first_date = date - Duration::days(29);
    let seven_date = date - Duration::days(6);
    let first_day = first_date.format("%Y-%m-%d").to_string();
    let seven_day = seven_date.format("%Y-%m-%d").to_string();
    let key = project_id.to_owned();
    let first_parameter = format!("{first_day}T00:00:00.000Z");
    let seven_parameter = format!("{seven_day}T00:00:00.000Z");
    let metrics = application
        .storage
        .execute(move |db| read_metrics(db, &key, &first_parameter, &seven_parameter))
        .await
        .map_err(app_error)?;
    let counts = metrics
        .daily_messages
        .into_iter()
        .collect::<std::collections::HashMap<_, _>>();
    let mut days = Vec::with_capacity(30);
    for offset in 0..30 {
        let day = first_date + Duration::days(offset);
        let label = day.format("%Y-%m-%d").to_string();
        days.push(json!({"date":label,"count":counts.get(&label).copied().unwrap_or(0)}));
    }
    Ok(ProjectMetrics {
        active_sessions,
        archived_sessions: metrics.archived_sessions,
        recent_messages_7d: metrics.recent_messages_7d,
        recent_messages_30d: metrics.recent_messages_30d,
        days,
    })
}

struct DatabaseMetrics {
    archived_sessions: usize,
    daily_messages: Vec<(String, usize)>,
    recent_messages_7d: usize,
    recent_messages_30d: usize,
}

fn read_metrics(
    db: &Connection,
    project_id: &str,
    first_day: &str,
    seven_day: &str,
) -> Result<DatabaseMetrics, AppStorageError> {
    let archived: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM chats WHERE project_id=?1 AND archived=1",
            [project_id],
            |row| row.get(0),
        )
        .map_err(AppStorageError::sqlite)?;
    let rows = {
        let mut statement = db
            .prepare(
                "SELECT substr(m.created_at,1,10),COUNT(*) FROM messages m \
                 JOIN chats c ON c.id=m.chat_id WHERE c.project_id=?1 AND m.created_at>=?2 \
                 GROUP BY substr(m.created_at,1,10) ORDER BY substr(m.created_at,1,10)",
            )
            .map_err(AppStorageError::sqlite)?;
        statement
            .query_map(params![project_id, first_day], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    usize::try_from(row.get::<_, i64>(1)?.max(0)).unwrap_or_default(),
                ))
            })
            .map_err(AppStorageError::sqlite)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppStorageError::sqlite)?
    };
    let count = |since: &str| -> Result<usize, AppStorageError> {
        db.query_row(
            "SELECT COUNT(*) FROM messages m JOIN chats c ON c.id=m.chat_id \
             WHERE c.project_id=?1 AND m.created_at>=?2",
            params![project_id, since],
            |row| Ok(usize::try_from(row.get::<_, i64>(0)?.max(0)).unwrap_or_default()),
        )
        .map_err(AppStorageError::sqlite)
    };
    Ok(DatabaseMetrics {
        archived_sessions: usize::try_from(archived.max(0)).unwrap_or_default(),
        daily_messages: rows,
        recent_messages_7d: count(seven_day)?,
        recent_messages_30d: count(first_day)?,
    })
}
