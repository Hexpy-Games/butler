use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::super::{AppApplication, GatewayApplicationError};
use super::contracts::{
    AppProjectDashboardRecordsQuery, AppProjectDashboardSnapshot, AppProjectDashboardWork,
    invalid_cursor, invalid_request, source_changed, unavailable,
};
use super::cursor;
use super::project::read_project;
use super::session_links::ProjectSessionLinks;
use crate::gateway::AppSessionSummary;
use crate::public_text::sanitize_public_text;

const LANES: [&str; 6] = ["planned", "active", "review", "blocked", "done", "other"];

#[derive(Clone, Debug, Deserialize, Serialize)]
struct BoardCursor {
    revision: String,
    id: String,
    kind: String,
    parent: Option<String>,
    lane: Option<String>,
}

pub(super) async fn get(
    application: &AppApplication,
    project_id: &str,
    query: AppProjectDashboardRecordsQuery,
) -> Result<Value, GatewayApplicationError> {
    if !matches!(query.kind.as_str(), "work" | "plan" | "task") || !(1..=100).contains(&query.limit)
    {
        return Err(invalid_request());
    }
    if let Some(lane) = query.lane.as_deref()
        && !LANES.contains(&lane)
    {
        return Err(invalid_request());
    }
    let project = read_project(application, project_id).await?;
    let Some(ledger_id) = project.ledger_project_id else {
        return Ok(unavailable("unbound"));
    };
    let snapshot = match application
        .dependencies
        .project_dashboard_ledger
        .snapshot(project.id.clone(), ledger_id)
        .await
    {
        Ok(snapshot) => snapshot,
        Err(_) => return Ok(unavailable("source_unavailable")),
    };
    let sessions = application
        .list_sessions(Some("project".into()), Some(project_id.to_owned()))
        .await?;
    let project_key = project.id.clone();
    let links = application
        .storage
        .execute(move |db| ProjectSessionLinks::read(db, &project_key))
        .await
        .map_err(super::super::app_error)?;
    let mut cards = board_cards(&snapshot, &query.kind, &sessions, &links);
    cards.retain(|card| {
        query
            .parent
            .as_deref()
            .is_none_or(|parent| card["parentId"].as_str() == Some(parent))
    });
    cards.sort_by(|a, b| {
        b["updatedAt"]
            .as_str()
            .cmp(&a["updatedAt"].as_str())
            .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
    });
    cards = interleave(&cards);
    let mut lane_counts = LANES
        .into_iter()
        .map(|lane| (lane, 0_u64))
        .collect::<std::collections::BTreeMap<_, _>>();
    for card in &cards {
        if let Some(count) = card["lane"]
            .as_str()
            .and_then(|lane| lane_counts.get_mut(lane))
        {
            *count += 1;
        }
    }
    if let Some(lane) = query.lane.as_deref() {
        cards.retain(|card| card["lane"].as_str() == Some(lane));
    }
    let mut offset = 0;
    if let Some(encoded) = query.cursor.as_deref() {
        let cursor: BoardCursor = cursor::decode(encoded)?;
        if cursor.revision != snapshot.revision {
            return Err(source_changed("Reload the board."));
        }
        if cursor.kind != query.kind || cursor.parent != query.parent || cursor.lane != query.lane {
            return Err(invalid_cursor());
        }
        let Some(index) = cards
            .iter()
            .position(|card| card["id"].as_str() == Some(&cursor.id))
        else {
            return Err(invalid_cursor());
        };
        offset = index + 1;
    }
    let total = cards.len();
    let items = cards
        .iter()
        .skip(offset)
        .take(query.limit)
        .cloned()
        .collect::<Vec<_>>();
    let next_cursor = if offset + items.len() < total {
        items.last().and_then(|last| {
            cursor::encode(&BoardCursor {
                revision: snapshot.revision.clone(),
                id: last["id"].as_str()?.to_owned(),
                kind: query.kind,
                parent: query.parent,
                lane: query.lane,
            })
            .ok()
        })
    } else {
        None
    };
    let parents = snapshot
        .works
        .iter()
        .map(|work| {
            json!({"id":work.record.id,"title":sanitize_public_text(work.managed.as_ref().map_or(&work.record.title, |managed| &managed.objective), "")})
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "status":"ready",
        "sourceRevision":snapshot.revision,
        "items":items,
        "total":total,
        "laneCounts":lane_counts,
        "parents":parents,
        "nextCursor":next_cursor,
    }))
}

pub(super) fn board_cards(
    snapshot: &AppProjectDashboardSnapshot,
    kind: &str,
    sessions: &[AppSessionSummary],
    links: &ProjectSessionLinks,
) -> Vec<Value> {
    let work_cards = snapshot
        .works
        .iter()
        .map(|work| work_card(snapshot, work, sessions, links))
        .collect::<Vec<_>>();
    if kind == "work" {
        return work_cards;
    }
    let managed = snapshot
        .works
        .iter()
        .filter(|work| {
            work.managed
                .as_ref()
                .and_then(|managed| managed.current_plan.as_ref())
                .is_some()
        })
        .collect::<Vec<_>>();
    let managed_work_ids = managed
        .iter()
        .map(|work| work.record.id.as_str())
        .collect::<std::collections::HashSet<_>>();
    let mut cards = snapshot
        .records
        .iter()
        .filter(|record| {
            record.kind == kind
                && !(kind == "plan"
                    && record
                        .parent_id
                        .as_deref()
                        .is_some_and(|id| managed_work_ids.contains(id)))
        })
        .map(|record| {
            let parent = work_cards
                .iter()
                .find(|work| work["id"].as_str() == record.parent_id.as_deref());
            let mut session = parent
                .and_then(|work| work.get("session"))
                .cloned()
                .unwrap_or(Value::Null);
            if session.is_object()
                && session["running"] == true
                && record_lane(&record.status) != "active"
            {
                session["running"] = Value::Bool(false);
            }
            json!({
                "id":record.id,
                "kind":kind,
                "title":sanitize_public_text(&record.title, ""),
                "parentId":record.parent_id,
                "status":record.status,
                "lane":record_lane(&record.status),
                "updatedAt":record.updated_at,
                "taskProgress":Value::Null,
                "actionProgress":Value::Null,
                "session":session,
            })
        })
        .collect::<Vec<_>>();
    if kind == "plan" {
        for work in managed {
            let Some(plan) = work
                .managed
                .as_ref()
                .and_then(|managed| managed.current_plan.as_ref())
            else {
                continue;
            };
            let parent = work_cards
                .iter()
                .find(|card| card["id"].as_str() == Some(&work.record.id));
            cards.push(json!({
                "id":plan.id,
                "kind":"plan",
                "title":sanitize_public_text(&plan.objective, ""),
                "parentId":work.record.id,
                "status":work.record.status,
                "lane":parent.map_or("other", |card| card["lane"].as_str().unwrap_or("other")),
                "updatedAt":plan.created_at,
                "taskProgress":Value::Null,
                "actionProgress":Value::Null,
                "session":parent.and_then(|card| card.get("session")).cloned().unwrap_or(Value::Null),
            }));
        }
    }
    cards
}

fn work_card(
    snapshot: &AppProjectDashboardSnapshot,
    work: &AppProjectDashboardWork,
    sessions: &[AppSessionSummary],
    links: &ProjectSessionLinks,
) -> Value {
    let status = super::overview::work_status(work);
    let session = work
        .managed
        .as_ref()
        .and_then(|managed| links.resolve(&managed.session_id, sessions));
    let action_progress = work.managed.as_ref().map(|managed| {
        let done = managed
            .action_progress
            .iter()
            .filter(|action| matches!(action.status.as_str(), "done" | "skipped"))
            .count();
        json!({"done":done,"total":managed.action_progress.len()})
    });
    let tasks = snapshot
        .records
        .iter()
        .filter(|record| {
            record.kind == "task" && record.parent_id.as_deref() == Some(&work.record.id)
        })
        .collect::<Vec<_>>();
    json!({
        "id":work.record.id,
        "kind":"work",
        "title":sanitize_public_text(work.managed.as_ref().map_or(&work.record.title, |managed| &managed.objective), ""),
        "parentId":Value::Null,
        "status":status,
        "lane":work_lane(&status, &work.record.status, work.managed.as_ref().and_then(|managed| managed.current_stage.as_deref())),
        "updatedAt":work.record.updated_at,
        "taskProgress":(!tasks.is_empty()).then(|| json!({"done":tasks.iter().filter(|task| task.status=="done").count(),"total":tasks.len()})),
        "actionProgress":action_progress,
        "session":session.map_or(Value::Null, |session| json!({
            "id":session.id,
            "title":sanitize_public_text(&session.title, ""),
            "running":status=="open" && super::overview::session_running(session),
        })),
    })
}

fn work_lane(status: &str, ledger_status: &str, stage: Option<&str>) -> &'static str {
    if status == "completed" {
        "done"
    } else if status == "blocked" {
        "blocked"
    } else if matches!(status, "unknown" | "abandoned") {
        "other"
    } else if ledger_status == "review" || stage == Some("review") {
        "review"
    } else if matches!(ledger_status, "proposed" | "scoped" | "specified") {
        "planned"
    } else {
        "active"
    }
}

fn record_lane(status: &str) -> &'static str {
    match status {
        "done" | "completed" | "accepted" => "done",
        "blocked" => "blocked",
        "review" => "review",
        "active" | "in_progress" => "active",
        "todo" | "draft" | "proposed" | "scoped" | "specified" | "planned" => "planned",
        _ => "other",
    }
}

fn interleave(cards: &[Value]) -> Vec<Value> {
    let buckets = LANES
        .iter()
        .map(|lane| {
            cards
                .iter()
                .filter(|card| card["lane"].as_str() == Some(lane))
                .cloned()
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    let longest = buckets.iter().map(Vec::len).max().unwrap_or(0);
    let mut result = Vec::with_capacity(cards.len());
    for index in 0..longest {
        for bucket in &buckets {
            if let Some(card) = bucket.get(index) {
                result.push(card.clone());
            }
        }
    }
    result
}
