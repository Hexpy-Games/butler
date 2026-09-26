//! Project Ledger snapshot cards and bounded history statistics.

use std::collections::{HashMap, HashSet};

use chrono::DateTime;
use serde_json::{Value, json};

use super::super::contracts::{
    AppProjectDashboardLedgerEvent, AppProjectDashboardSnapshot,
    AppProjectDashboardWorkHistoryEntry,
};
use super::super::session_links::ProjectSessionLinks;
use super::calendar::Calendar;
use super::view::{add, day_index, set_source};
use crate::public_text::sanitize_public_text;

pub(super) fn populate(
    view: &mut Value,
    calendar: &Calendar,
    snapshot: &AppProjectDashboardSnapshot,
    history: Option<(
        &[AppProjectDashboardLedgerEvent],
        &[AppProjectDashboardWorkHistoryEntry],
    )>,
) {
    let labels = calendar
        .days
        .iter()
        .map(|day| day.date.clone())
        .collect::<Vec<_>>();
    let metrics = ["created", "completed", "executed"];
    let work_cards =
        super::super::board::board_cards(snapshot, "work", &[], &ProjectSessionLinks::empty());
    let task_cards =
        super::super::board::board_cards(snapshot, "task", &[], &ProjectSessionLinks::empty());
    let mut cards = serde_json::Map::new();
    cards.insert(
        "work".into(),
        project_cards(view, snapshot, &work_cards, "work", calendar),
    );
    cards.insert(
        "task".into(),
        project_cards(view, snapshot, &task_cards, "task", calendar),
    );
    view["work"] = json!({
        "work":super::view::series(&labels, &metrics),
        "task":super::view::series(&labels, &["created"]),
        "cards":cards,
        "excluded":0,
        "activity":[],
    });
    view["ledgerHistoryAvailable"] = Value::Bool(history.is_some());
    let Some((ledger, managed)) = history else {
        return;
    };
    apply_history(view, calendar, snapshot, ledger, managed);
}

fn project_cards(
    view: &mut Value,
    snapshot: &AppProjectDashboardSnapshot,
    cards: &[Value],
    kind: &str,
    calendar: &Calendar,
) -> Value {
    let mut output = Vec::with_capacity(cards.len());
    for card in cards {
        let id = card["id"].as_str().unwrap_or_default();
        let title = card["title"].as_str().unwrap_or_default();
        let updated_at = card["updatedAt"].as_str().unwrap_or_default();
        let source_key = format!("{kind}:{id}");
        set_source(
            view,
            &source_key,
            json!({
                "title":title,
                "at":updated_at,
                "source":{"kind":kind,"id":id,"revision":snapshot.revision},
            }),
        );
        let age_days = match (
            DateTime::parse_from_rfc3339(&calendar.observed_at),
            DateTime::parse_from_rfc3339(updated_at),
        ) {
            (Ok(observed), Ok(updated)) => {
                let age = observed.timestamp_millis() - updated.timestamp_millis();
                (age >= 0).then_some(age / 86_400_000)
            }
            _ => None,
        };
        let mut card = card.clone();
        card["sourceKey"] = Value::String(source_key);
        card["ageDays"] = age_days.map_or(Value::Null, |value| json!(value));
        output.push(card);
    }
    Value::Array(output)
}

struct HistoryItem<'a> {
    id: &'a str,
    record_id: &'a str,
    kind: &'a str,
    at: &'a str,
    action: &'a str,
    managed: bool,
}

fn apply_history(
    view: &mut Value,
    calendar: &Calendar,
    snapshot: &AppProjectDashboardSnapshot,
    ledger: &[AppProjectDashboardLedgerEvent],
    managed: &[AppProjectDashboardWorkHistoryEntry],
) {
    let records = snapshot
        .records
        .iter()
        .map(|record| ((record.kind.as_str(), record.id.as_str()), record))
        .collect::<HashMap<_, _>>();
    let managed_ids = snapshot
        .works
        .iter()
        .filter(|work| work.managed.is_some())
        .map(|work| work.record.id.as_str())
        .collect::<HashSet<_>>();
    let unavailable_ids = snapshot
        .works
        .iter()
        .filter(|work| work.availability != "ready")
        .map(|work| work.record.id.as_str())
        .collect::<HashSet<_>>();
    let mut items = ledger
        .iter()
        .map(|event| HistoryItem {
            id: &event.id,
            record_id: &event.record_id,
            kind: &event.kind,
            at: &event.at,
            action: &event.action,
            managed: false,
        })
        .chain(managed.iter().map(|event| HistoryItem {
            id: &event.id,
            record_id: &event.work_id,
            kind: "work",
            at: &event.at,
            action: if event.action == "disposition" && event.status == "completed" {
                "executed"
            } else {
                &event.action
            },
            managed: true,
        }))
        .collect::<Vec<_>>();
    items.sort_by(|a, b| a.at.cmp(b.at).then_with(|| a.id.cmp(b.id)));
    let mut seen = HashSet::new();
    let mut activity = HashMap::<String, Activity>::new();
    for event in items {
        let Some(day) = day_index(&calendar.days, event.at) else {
            continue;
        };
        let source_key = format!("{}:{}", event.kind, event.record_id);
        let Some(record) = records.get(&(event.kind, event.record_id)) else {
            increment(view, "work.excluded");
            continue;
        };
        if record.unavailable || unavailable_ids.contains(event.record_id) {
            increment(view, "work.excluded");
            continue;
        }
        if view["sources"].get(&source_key).is_none() {
            set_source(
                view,
                &source_key,
                json!({
                    "title":sanitize_public_text(&record.title, ""),
                    "at":record.updated_at,
                    "source":{"kind":record.kind,"id":record.id,"revision":snapshot.revision},
                }),
            );
        }
        if matches!(event.kind, "work" | "task") {
            if event.action == "result"
                || (managed_ids.contains(event.record_id)
                    && !event.managed
                    && event.action != "created")
            {
                continue;
            }
            add(view, &["activity"], day, "work", &source_key);
            if event.kind == "work" {
                let item = activity.entry(source_key.clone()).or_default();
                item.dates.insert(calendar.days[day].date.clone());
                item.changes += 1;
            }
            if matches!(event.action, "created" | "completed" | "executed") {
                let identity = format!("{source_key}:{}", event.action);
                if seen.insert(identity) {
                    add(view, &["work", event.kind], day, event.action, &source_key);
                }
            }
        } else if matches!(event.kind, "spec" | "plan" | "report")
            && matches!(event.action, "created" | "updated")
        {
            add(view, &["materials"], day, event.action, &source_key);
            add(view, &["materialTypes"], day, event.kind, &source_key);
            add(view, &["activity"], day, "materials", &source_key);
        }
    }
    let mut activity = activity
        .into_iter()
        .map(|(source_key, item)| {
            json!({
                "sourceKey":source_key,
                "dates":item.dates,
                "changes":item.changes,
            })
        })
        .collect::<Vec<_>>();
    activity.sort_by(|a, b| {
        b["changes"]
            .as_u64()
            .cmp(&a["changes"].as_u64())
            .then_with(|| a["sourceKey"].as_str().cmp(&b["sourceKey"].as_str()))
    });
    view["work"]["activity"] = Value::Array(activity);
    let missing_completed = snapshot
        .works
        .iter()
        .filter(|work| {
            work.managed
                .as_ref()
                .is_some_and(|managed| managed.status == "completed")
                && !managed.iter().any(|event| {
                    event.work_id == work.record.id
                        && event.action == "disposition"
                        && event.status == "completed"
                })
        })
        .count();
    increment_by(view, "work.excluded", missing_completed);
}

#[derive(Default)]
struct Activity {
    dates: std::collections::BTreeSet<String>,
    changes: u64,
}

fn increment(view: &mut Value, path: &str) {
    increment_by(view, path, 1);
}

fn increment_by(view: &mut Value, path: &str, amount: usize) {
    let mut target = &mut *view;
    for part in path.split('.') {
        target = &mut target[part];
    }
    *target = json!(target.as_u64().unwrap_or(0).saturating_add(amount as u64));
}
