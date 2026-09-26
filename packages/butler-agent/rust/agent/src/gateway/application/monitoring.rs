//! Read-only Desktop monitor contracts and projections over native App facts.

mod conversation;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};

use crate::gateway::{
    AppSessionSummary, ApplicationFuture, GatewayApplication, GatewayApplicationError,
};

#[derive(Clone, Debug, Default)]
pub(crate) struct AppMonitorPage {
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct AppUsageMonitorQuery {
    pub session_id: Option<String>,
    pub since_ts: Option<f64>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct AppDeveloperLogsQuery {
    pub limit: Option<usize>,
    pub offset: Option<usize>,
    pub session_id: Option<String>,
    pub turn_id: Option<String>,
    pub kind: Option<String>,
    pub query: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct AppWorkerActivityQuery {
    pub session_id: Option<String>,
    pub include_history: bool,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
    pub cursor: Option<String>,
}

/// Native-neutral facts copied from the BTCC Work owner for App projection.
#[derive(Clone, Debug)]
pub(crate) struct AppBoundWorkStatusFact {
    pub session_id: String,
    pub status: String,
    pub disposition_status: Option<String>,
    pub turn_state: Option<String>,
    pub runtime_owned_open: bool,
    pub safe_title: String,
    pub summary: String,
    pub stage: Option<String>,
    pub action_progress: Vec<String>,
    pub effect_count: u64,
    pub unresolved_blocker_count: u64,
    pub updated_at: String,
    pub operational_notice: Option<AppWorkOperationalNoticeFact>,
}

#[derive(Clone, Debug)]
pub(crate) struct AppWorkOperationalNoticeFact {
    pub status: String,
    pub summary: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct AppWorkStatusConversationFact {
    pub latest_report_summary: Option<String>,
    pub recent_artifacts: Vec<String>,
}

/// File-backed monitor reads remain owned by the native Host projection.
pub(crate) trait AppMonitoringPort: Send + Sync + 'static {
    fn work_status(&self) -> ApplicationFuture<Vec<AppBoundWorkStatusFact>>;
    fn usage_monitor(&self, query: AppUsageMonitorQuery) -> ApplicationFuture<Value>;
    fn system_events(&self, page: AppMonitorPage) -> ApplicationFuture<Value>;
    fn developer_logs(&self, query: AppDeveloperLogsQuery) -> ApplicationFuture<Value>;
}

pub(crate) async fn work_status(
    application: &dyn GatewayApplication,
) -> Result<Value, GatewayApplicationError> {
    let facts = application.work_status().await?;
    let mut view = project_work_status(facts);
    let sessions = application.list_sessions(None, None).await?;
    if let Some(items) = view.get_mut("items").and_then(Value::as_array_mut) {
        for item in items {
            let Some(work_session_id) = item.get("session_id").and_then(Value::as_str) else {
                continue;
            };
            let Some(session) = sessions.iter().find(|session| {
                session.id == work_session_id || session.session_hint == work_session_id
            }) else {
                continue;
            };
            let conversation = application
                .work_status_conversation(session.id.clone())
                .await?;
            if let Some(summary) = conversation.latest_report_summary {
                item["latest_report_summary"] = json!(summary);
            }
            if !conversation.recent_artifacts.is_empty() {
                item["recent_artifacts"] = json!(conversation.recent_artifacts);
            }
        }
    }
    Ok(view)
}

pub(crate) fn project_work_status(facts: Vec<AppBoundWorkStatusFact>) -> Value {
    let mut items = facts
        .into_iter()
        .map(|fact| {
            let state = work_state(&fact);
            let completed_actions = fact
                .action_progress
                .iter()
                .filter(|status| matches!(status.as_str(), "done" | "skipped"))
                .count();
            let total_actions = fact.action_progress.len();
            let safe_title =
                crate::public_text::sanitize_public_text(&fact.safe_title, "Butler work");
            let summary = fact
                .operational_notice
                .as_ref()
                .filter(|notice| matches!(notice.status.as_str(), "recovering" | "interrupted"))
                .map(|notice| notice.summary.as_str())
                .unwrap_or(&fact.summary);
            let safe_summary =
                crate::public_text::sanitize_public_text(summary, "Work status is available.");
            let stage = fact.stage.filter(|stage| {
                matches!(
                    stage.as_str(),
                    "conception" | "planning" | "execution" | "review" | "validation" | "reporting"
                )
            });
            let mut item = json!({
                "session_id": fact.session_id,
                "safe_title": safe_title,
                "safe_summary": safe_summary,
                "state": state,
                "completed_actions": completed_actions,
                "total_actions": total_actions,
                "effect_count": fact.effect_count,
                "updated_at": fact.updated_at,
            });
            if let Some(stage) = stage {
                item["stage"] = json!(stage);
            }
            item
        })
        .collect::<Vec<_>>();
    items.sort_by(|left, right| {
        work_state_priority(left["state"].as_str().unwrap_or("attention"))
            .cmp(&work_state_priority(
                right["state"].as_str().unwrap_or("attention"),
            ))
            .then_with(|| {
                right["updated_at"]
                    .as_str()
                    .cmp(&left["updated_at"].as_str())
            })
    });
    items.truncate(8);
    let mut counts = json!({
        "running": 0_u64,
        "completed": 0_u64,
        "attention": 0_u64,
        "operational_action": 0_u64,
        "operational_interruption": 0_u64,
    });
    for item in &items {
        if let Some(state) = item["state"].as_str()
            && let Some(count) = counts
                .get(state)
                .and_then(|value| value.as_u64())
                .map(|n| n + 1)
        {
            counts[state] = json!(count);
        }
    }
    json!({ "items": items, "counts": counts })
}

fn work_state(fact: &AppBoundWorkStatusFact) -> &'static str {
    if fact
        .operational_notice
        .as_ref()
        .is_some_and(|notice| notice.status == "interrupted")
    {
        "operational_interruption"
    } else if fact
        .operational_notice
        .as_ref()
        .is_some_and(|notice| notice.status == "recovering")
    {
        "operational_action"
    } else if fact.disposition_status.as_deref() == Some("blocked")
        || fact.status == "blocked"
        || fact.runtime_owned_open
        || fact.unresolved_blocker_count > 0
    {
        "attention"
    } else if fact.disposition_status.as_deref() == Some("completed") || fact.status == "completed"
    {
        "completed"
    } else if matches!(
        fact.turn_state.as_deref(),
        Some("admitted" | "delivery_committed")
    ) {
        "running"
    } else {
        "attention"
    }
}

fn work_state_priority(state: &str) -> u8 {
    match state {
        "operational_interruption" => 0,
        "operational_action" => 1,
        "attention" => 2,
        "running" => 3,
        _ => 4,
    }
}

pub(crate) async fn worker_activity(
    application: &dyn GatewayApplication,
    query: AppWorkerActivityQuery,
) -> Result<Value, GatewayApplicationError> {
    let sessions = application.list_sessions(None, None).await?;
    let requested_session = query
        .session_id
        .as_deref()
        .filter(|value| !value.is_empty());
    let mut workers = Vec::new();
    for session in sessions.into_iter().filter(|session| {
        requested_session.is_none_or(|id| id == session.id || id == session.session_hint)
    }) {
        let projection = application
            .subsession_projection(session.session_hint.clone())
            .await?;
        append_relation_workers(
            &mut workers,
            &projection,
            &session,
            "workers",
            "worker",
            query.include_history,
        );
        append_relation_workers(
            &mut workers,
            &projection,
            &session,
            "steward_children",
            "steward",
            query.include_history,
        );
    }
    workers.sort_by(|left, right| {
        right["updated_at"]
            .as_str()
            .cmp(&left["updated_at"].as_str())
            .then_with(|| left["worker_id"].as_str().cmp(&right["worker_id"].as_str()))
    });

    let limit = bounded_page(query.limit, 200, 1, 200);
    let offset = bounded_page(query.offset, 0, 0, usize::MAX);
    let cursor_offset = decode_activity_cursor(query.cursor.as_deref(), &workers);
    let page_offset = cursor_offset.unwrap_or(offset);
    let page = workers
        .iter()
        .skip(page_offset)
        .take(limit)
        .cloned()
        .collect::<Vec<_>>();
    let has_more = page_offset.saturating_add(page.len()) < workers.len();
    let mut pagination = json!({
        "limit": limit,
        "offset": page_offset,
        "has_more": has_more,
    });
    if has_more && let Some(worker_id) = page.last().and_then(|worker| worker["worker_id"].as_str())
    {
        pagination["next_cursor"] = json!(encode_activity_cursor(worker_id));
    }
    Ok(json!({ "workers": page, "pagination": pagination }))
}

fn append_relation_workers(
    workers: &mut Vec<Value>,
    projection: &Value,
    session: &AppSessionSummary,
    collection: &str,
    role: &str,
    include_history: bool,
) {
    let Some(children) = projection.get(collection).and_then(Value::as_array) else {
        return;
    };
    for child in children {
        let status = child
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("waiting");
        if !include_history && !matches!(status, "active" | "waiting") {
            continue;
        }
        let relation = &child["relation"];
        let task_id = child
            .pointer("/result/task_id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty());
        let relation_id = relation
            .get("relation_id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty());
        let Some(identity) = task_id.or(relation_id) else {
            continue;
        };
        let worker_id = format!("{role}-{identity}");
        let title = child
            .get("title")
            .and_then(Value::as_str)
            .or_else(|| relation.get("safe_title").and_then(Value::as_str))
            .unwrap_or("Native child Work");
        let phase = worker_phase(status);
        let ordinal = relation.get("ordinal").and_then(Value::as_u64).unwrap_or(0);
        let label = if role == "steward" {
            "Steward"
        } else {
            "Worker"
        };
        let ordinal_label = if role == "steward" || ordinal == 0 {
            label.to_owned()
        } else {
            format!("{label} {ordinal}")
        };
        let updated_at = child
            .get("updated_at")
            .and_then(Value::as_str)
            .or_else(|| relation.get("created_at").and_then(Value::as_str))
            .unwrap_or("");
        let mut worker = json!({
            "worker_id": worker_id,
            "activity_kind": "worker",
            "worker_label": label,
            "worker_display_name": label,
            "worker_ordinal_label": ordinal_label,
            "objective": crate::public_text::sanitize_public_text(title, "Native child Work"),
            "phase": phase,
            "status_line": worker_status_line(status),
            "session_id": session.id,
            "terminal": matches!(phase, "complete" | "blocked" | "failed" | "cancelled" | "recoverable"),
            "updated_at": updated_at,
            "supported_controls": [],
        });
        if let Some(parent_turn_id) = relation.get("parent_turn_id").and_then(Value::as_str) {
            worker["parent_turn_id"] = json!(parent_turn_id);
        }
        if let Some(task_id) = task_id {
            worker["task_id"] = json!(task_id);
        }
        if let Some(created_at) = relation.get("created_at").and_then(Value::as_str) {
            worker["created_at"] = json!(created_at);
        }
        workers.push(worker);
    }
}

fn worker_phase(status: &str) -> &'static str {
    match status {
        "active" => "executing",
        "completed" => "complete",
        "blocked" => "blocked",
        "failed" => "failed",
        "cancelled" => "cancelled",
        "recoverable" => "recoverable",
        _ => "orienting",
    }
}

fn worker_status_line(status: &str) -> &'static str {
    match status {
        "active" => "Working",
        "completed" => "Completed",
        "blocked" => "Blocked",
        "failed" => "Failed",
        "cancelled" => "Cancelled",
        "recoverable" => "Recoverable",
        _ => "Waiting",
    }
}

fn bounded_page(value: Option<usize>, fallback: usize, minimum: usize, maximum: usize) -> usize {
    value.map_or(fallback, |value| value.clamp(minimum, maximum))
}

fn encode_activity_cursor(worker_id: &str) -> String {
    URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&json!({ "v": 1, "worker_id": worker_id })).unwrap_or_default())
}

fn decode_activity_cursor(cursor: Option<&str>, workers: &[Value]) -> Option<usize> {
    let decoded = URL_SAFE_NO_PAD.decode(cursor?).ok()?;
    let value: Value = serde_json::from_slice(&decoded).ok()?;
    if value.get("v").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    let worker_id = value.get("worker_id")?.as_str()?;
    workers
        .iter()
        .position(|worker| worker.get("worker_id").and_then(Value::as_str) == Some(worker_id))
        .map(|index| index + 1)
}
