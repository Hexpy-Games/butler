use serde_json::{Value, json};

use super::{storage::Store, support::*};
use crate::{btcc::BtccError, gateway::AppWorkStreamTurnOutcome};

impl Store {
    pub(super) fn reconcile_turn(
        &mut self,
        outcome: AppWorkStreamTurnOutcome,
    ) -> Result<(), BtccError> {
        self.recover_pending()?;
        validate_outcome(&outcome.outcome)?;
        let candidates = self
            .records()?
            .into_iter()
            .filter(|record| eligible(record, &outcome))
            .filter_map(|record| string(&record, "id"))
            .collect::<Vec<_>>();
        for id in candidates {
            self.reconcile_one(&id, &outcome)?;
        }
        Ok(())
    }

    fn reconcile_one(&self, id: &str, outcome: &AppWorkStreamTurnOutcome) -> Result<(), BtccError> {
        self.with_lock(id, "legacy_outcome", |current| {
            let Some(mut record) = current else {
                return Ok(());
            };
            if !eligible(&record, outcome) {
                return Ok(());
            }
            if outcome.outcome == "cancelled"
                && record
                    .get("active_contract_id")
                    .is_some_and(|value| !value.is_null())
            {
                return Err(error("workstream_claimed_cancel_requires_receipt"));
            }
            let now = now_iso();
            if let Some(list_id) = string(&record, "todo_list_id") {
                let path = self.root.join("todos").join(format!("{list_id}.json"));
                if let Some(mut todo) = read_object(&path)? {
                    update_todo(&mut todo, &outcome.outcome, &now)?;
                    write_atomic(&path, &todo)?;
                }
            }
            let map = record
                .as_object_mut()
                .ok_or_else(|| error("work_stream_record_invalid"))?;
            let terminal = matches!(
                outcome.outcome.as_str(),
                "completed" | "failed" | "cancelled"
            );
            map.insert("state".into(), json!(outcome_state(&outcome.outcome)));
            if terminal {
                map.insert("current_phase".into(), Value::Null);
                map.insert("active_step_id".into(), Value::Null);
            }
            map.insert(
                "status_note".into(),
                json!(status_note(&outcome.outcome, &outcome.status_note)),
            );
            map.insert("updated_at".into(), json!(now));
            let generation = map
                .get("record_generation")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                + 1;
            map.insert("record_generation".into(), json!(generation));
            write_atomic(
                &self.root.join("work-streams").join(format!("{id}.json")),
                &record,
            )
        })
    }
}

fn eligible(record: &Value, outcome: &AppWorkStreamTurnOutcome) -> bool {
    if string(record, "owner_session_id").as_deref() != Some(&outcome.session_id)
        || string(record, "last_user_turn_id").as_deref() != Some(&outcome.turn_id)
        || terminal(record)
        || linked(record)
    {
        return false;
    }
    let state = string(record, "state");
    !((outcome.outcome == "failed" && state.as_deref() == Some("recoverable"))
        || (outcome.outcome == "completed"
            && matches!(state.as_deref(), Some("recoverable" | "paused"))))
}

fn linked(record: &Value) -> bool {
    [
        "linked_planned_task_ids",
        "linked_orchestration_ids",
        "linked_worker_task_ids",
    ]
    .iter()
    .any(|key| {
        record
            .get(key)
            .and_then(Value::as_array)
            .is_some_and(|values| !values.is_empty())
    })
}

fn validate_outcome(outcome: &str) -> Result<(), BtccError> {
    if matches!(
        outcome,
        "completed" | "failed" | "cancelled" | "recoverable" | "waiting_user"
    ) {
        Ok(())
    } else {
        Err(error("work_stream_outcome_invalid"))
    }
}

fn outcome_state(outcome: &str) -> &str {
    match outcome {
        "completed" => "complete",
        other => other,
    }
}

fn update_todo(todo: &mut Value, outcome: &str, now: &str) -> Result<(), BtccError> {
    let items = todo
        .get_mut("items")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| error("todo_items_invalid"))?;
    for item in items {
        let prior = string(item, "status").ok_or_else(|| error("todo_status_invalid"))?;
        if matches!(prior.as_str(), "completed" | "cancelled") {
            continue;
        }
        let phase = string(item, "phase");
        let status = if outcome == "completed" && phase.as_deref() == Some("reporting") {
            "completed"
        } else if matches!(outcome, "recoverable" | "waiting_user") {
            "pending"
        } else {
            "cancelled"
        };
        let map = item
            .as_object_mut()
            .ok_or_else(|| error("todo_item_invalid"))?;
        map.insert("status".into(), json!(status));
        map.insert("updated_at".into(), json!(now));
        map.insert(
            "completed_at".into(),
            if status == "completed" {
                json!(now)
            } else {
                Value::Null
            },
        );
        if map.get("note").is_none_or(Value::is_null) {
            map.insert("note".into(), json!(outcome_note(outcome)));
        }
    }
    todo.as_object_mut()
        .ok_or_else(|| error("todo_record_invalid"))?
        .insert("updated_at".into(), json!(now));
    Ok(())
}

fn outcome_note(outcome: &str) -> &'static str {
    match outcome {
        "completed" => "No longer applicable after the turn completed.",
        "failed" => "Cancelled because the turn failed.",
        "cancelled" => "Cancelled with the turn.",
        "waiting_user" => "Paused until the user decision is available.",
        _ => "Paused in the active projection; resume from the recoverable WorkStream.",
    }
}

fn bounded_note(note: &str) -> String {
    note.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(600)
        .collect()
}

fn status_note(outcome: &str, note: &str) -> String {
    let bounded = bounded_note(note);
    if !bounded.is_empty() {
        return bounded;
    }
    match outcome {
        "completed" => "Turn outcome completed; local work is no longer active.",
        "failed" => "Turn outcome failed; local work needs a fresh retry.",
        "cancelled" => "Turn outcome cancelled; local work is no longer active.",
        "waiting_user" => "Turn is waiting for user input.",
        _ => "Turn became recoverable before final delivery.",
    }
    .into()
}
